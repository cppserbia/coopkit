import fs from "node:fs";
import path from "node:path";
import type { EventFrontmatter, NormalizedEvent, PublishedEventRef } from "@coopkit/core";
import { frontmatterToNormalizedEvent } from "@coopkit/core";
import matter from "gray-matter";
import {
  MeetupApiError,
  type MeetupClient,
  type MeetupCredentials,
  createMeetupClient,
} from "./client.js";
import { fetchGroupInfo } from "./list-groups.js";
import {
  type CreateEventPayload,
  type CreatedEventBookkeeping,
  buildCreateEventPayload,
  createdGroupEvents,
  detectContentType,
  isEventAlreadyCreated,
  meetupEventsRows,
  mergeCreatedGroupEvents,
  stripLeadingHeading,
} from "./payload.js";
import type { SpeakerDetailsInput } from "./speaker.js";
import { type VenueMap, resolveVenueId } from "./venues.js";

const CREATE_EVENT_MUTATION = `
  mutation CreateDraftEvent($input: CreateEventInput!) {
    createEvent(input: $input) {
      event {
        id
        eventUrl
      }
      errors {
        message
        code
        field
      }
    }
  }
`;

const CREATE_EVENT_PHOTO_MUTATION = `
  mutation CreateEventPhoto($input: GroupEventPhotoCreateInput!) {
    createGroupEventPhoto(input: $input) {
      photo { id }
      uploadUrl
      error { message code field }
    }
  }
`;

const EDIT_EVENT_SPEAKER_MUTATION = `
  mutation EditEventSpeaker($input: EditEventInput!) {
    editEvent(input: $input) {
      event { id }
      errors { message code field }
    }
  }
`;

const GROUP_BY_URLNAME_QUERY = `
  query GetGroupId($urlname: String!) {
    groupByUrlname(urlname: $urlname) {
      id
    }
  }
`;

interface CreatedEvent {
  id: string;
  eventUrl: string;
}

interface GqlErrors {
  errors: Array<{ message: string; code?: string; field?: string }> | null;
}

function formatErrors(errs: GqlErrors["errors"]): string {
  return (errs ?? [])
    .map((e) => `${e.field ?? "?"}: ${e.message}${e.code ? ` (${e.code})` : ""}`)
    .join("; ");
}

async function getGroupId(client: MeetupClient, urlname: string): Promise<string> {
  const data = await client.graphql<{ groupByUrlname: { id: string } | null }>(
    GROUP_BY_URLNAME_QUERY,
    { urlname }
  );
  if (!data.groupByUrlname?.id) {
    throw new Error(`Meetup group not found for urlname "${urlname}".`);
  }
  return data.groupByUrlname.id;
}

async function callCreateEvent(
  client: MeetupClient,
  payload: CreateEventPayload
): Promise<CreatedEvent> {
  const data = await client.graphql<{
    createEvent: { event: CreatedEvent | null } & GqlErrors;
  }>(CREATE_EVENT_MUTATION, { input: payload });

  const result = data.createEvent;
  if (!result.event) {
    const details = formatErrors(result.errors);
    throw new MeetupApiError(
      `createEvent returned no event. ${details || "(no error details)"}`,
      result.errors ?? undefined
    );
  }
  return result.event;
}

/**
 * Upload an image as a photo of `eventId` and return the new photo's ID.
 * Meetup's flow is two steps: `createGroupEventPhoto` registers the photo and
 * hands back an `uploadUrl`, then the bytes are PUT there.
 */
async function uploadEventPhoto(
  client: MeetupClient,
  input: { groupId: string; eventId: string; imageUrl: string; setAsMain: boolean }
): Promise<string> {
  const { groupId, eventId, imageUrl, setAsMain } = input;
  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) {
    throw new Error(`Failed to fetch image ${imageUrl}: ${imgResp.status}`);
  }
  const contentTypeHeader = imgResp.headers.get("content-type");
  const contentType = detectContentType(contentTypeHeader);
  const buffer = Buffer.from(await imgResp.arrayBuffer());

  const photoResp = await client.graphql<{
    createGroupEventPhoto: {
      photo: { id: string } | null;
      uploadUrl: string | null;
      error: { message: string; code: string; field?: string | null } | null;
    };
  }>(CREATE_EVENT_PHOTO_MUTATION, {
    input: {
      groupId,
      eventId,
      photoType: "EVENT_PHOTO",
      contentType,
      setAsMain,
    },
  });

  const { photo, uploadUrl, error } = photoResp.createGroupEventPhoto;
  if (error) {
    throw new MeetupApiError(
      `createGroupEventPhoto failed: ${error.message}${error.code ? ` (${error.code})` : ""}`,
      [{ message: error.message, code: error.code, field: error.field ?? undefined }]
    );
  }
  if (!photo || !uploadUrl) {
    throw new MeetupApiError("createGroupEventPhoto returned no photo or uploadUrl.");
  }

  await client.uploadPhoto(uploadUrl, buffer, contentTypeHeader ?? "image/jpeg");
  return photo.id;
}

/**
 * The headshot to attach to the speaker profile, or undefined when there is
 * nothing to attach: the profile is not being sent (group not opted in, or no
 * bio) or the speaker has no `avatarUrl`. Only consulted when the caller opted
 * into the photo (`includeSpeakerPhoto`).
 *
 * Like the featured photo (`imageUrl`), the headshot is downloaded with
 * `fetch`, so only an http(s) URL works. `NormalizedSpeaker.avatarUrl` may also
 * be a filesystem path; that is skipped with a warning rather than failing
 * mid-upload.
 */
function speakerPhotoUrl(
  event: NormalizedEvent,
  payload: CreateEventPayload,
  log: (message: string) => void
): string | undefined {
  const avatarUrl = event.speaker?.avatarUrl?.trim();
  if (!payload.speakerDetails || !avatarUrl) return undefined;
  if (!/^https?:\/\//i.test(avatarUrl)) {
    log(
      `[warn] Speaker photo skipped: avatarUrl must be an http(s) URL, got ${JSON.stringify(avatarUrl)}.`
    );
    return undefined;
  }
  return avatarUrl;
}

/**
 * Give an already-created event's speaker profile its photo.
 *
 * `SpeakerDetailsInput.photoId` must name a photo that already belongs to the
 * group, and no mutation uploads a photo for a speaker as such. So the headshot
 * is uploaded as one of the event's photos, then the whole profile is sent
 * again through `editEvent`, now with `photoId`.
 */
async function attachSpeakerPhoto(
  client: MeetupClient,
  input: {
    groupId: string;
    eventId: string;
    avatarUrl: string;
    speakerDetails: SpeakerDetailsInput;
  }
): Promise<void> {
  // There is no speaker PhotoType. EVENT_PHOTO tied to this event is the
  // narrowest owner on offer, and the one the featured photo already uploads
  // with: GROUP_PHOTO would land among the group's own photos, and
  // MEMBER_PHOTO belongs to a member profile (the organizer's, not the
  // speaker's). setAsMain: false keeps the banner as the featured photo.
  const photoId = await uploadEventPhoto(client, {
    groupId: input.groupId,
    eventId: input.eventId,
    imageUrl: input.avatarUrl,
    setAsMain: false,
  });
  // Meetup reads photoId 0 (or no photoId) as "no photo", which editEvent
  // would accept without error, so anything but a positive integer is refused
  // here rather than reported as attached.
  if (!/^[1-9]\d*$/.test(photoId)) {
    throw new MeetupApiError(
      `createGroupEventPhoto returned photo id ${JSON.stringify(photoId)}; speakerDetails.photoId needs a positive integer.`
    );
  }

  const data = await client.graphql<{
    editEvent: { event: { id: string } | null } & GqlErrors;
  }>(EDIT_EVENT_SPEAKER_MUTATION, {
    input: { eventId: input.eventId, speakerDetails: { ...input.speakerDetails, photoId } },
  });

  const result = data.editEvent;
  if (!result.event || (result.errors?.length ?? 0) > 0) {
    const details = formatErrors(result.errors);
    throw new MeetupApiError(
      `editEvent did not set the speaker photo. ${details || "(no error details)"}`,
      result.errors ?? undefined
    );
  }
}

export interface CreateMeetupDraftOptions {
  event: NormalizedEvent;
  groupUrlname: string;
  venues: VenueMap;
  /** IANA timezone of the group. See `BuildPayloadInput.timezone`. */
  timezone?: string;
  /** Meetup member IDs to list as event hosts. */
  hosts?: number[];
  /** Attach `event.speaker` as Meetup's Pro speaker profile. */
  includeSpeaker?: boolean;
  /**
   * Also give that profile its photo: upload `event.speaker.avatarUrl` (an
   * http(s) URL) after the event is created and set it with `editEvent`.
   * Opt-in, default false; without it `avatarUrl` is ignored. Has no effect
   * unless the profile itself is sent (`includeSpeaker`, and a speaker bio).
   */
  includeSpeakerPhoto?: boolean;
  dryRun?: boolean;
  credentials?: MeetupCredentials;
  log?: (message: string) => void;
  /**
   * Invoked once after a successful create (and after the optional featured
   * and speaker photo uploads). The adopter persists `eventId` + `eventUrl`
   * wherever their source-of-truth lives — frontmatter, an events.yml, a
   * database, etc.
   */
  onCreated?: (info: {
    event: NormalizedEvent;
    /** The group the event was created in — the caller may be creating in several. */
    groupUrlname: string;
    result: {
      eventId: string;
      eventUrl: string;
      photoAttached: boolean;
      speakerPhotoAttached: boolean;
    };
  }) => Promise<void> | void;
}

export type CreateMeetupDraftResult =
  | { status: "dry-run"; payload: CreateEventPayload }
  | {
      status: "created";
      eventId: string;
      eventUrl: string;
      photoAttached: boolean;
      /**
       * Whether `speaker.avatarUrl` ended up as the speaker profile's photo.
       * Always false without `includeSpeakerPhoto`.
       */
      speakerPhotoAttached: boolean;
    };

/**
 * Primary, platform-neutral entry point. Takes a `NormalizedEvent` from any
 * source — file-per-event, README bullet list, YAML data, CMS, anything —
 * and creates a Draft Meetup event for it. The optional `onCreated` callback
 * is where the adopter writes back the IDs to their source.
 */
export async function createMeetupDraft(
  options: CreateMeetupDraftOptions
): Promise<CreateMeetupDraftResult> {
  const log = options.log ?? ((m) => console.error(m));

  const payload = buildCreateEventPayload({
    event: options.event,
    groupUrlname: options.groupUrlname,
    resolveVenue: (name) => resolveVenueId(name, options.venues),
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    ...(options.hosts !== undefined ? { hosts: options.hosts } : {}),
    ...(options.includeSpeaker !== undefined ? { includeSpeaker: options.includeSpeaker } : {}),
  });

  if (options.includeSpeaker && !payload.speakerDetails) {
    log(
      "[warn] speakerDetails requested but not sent: the event has no speaker with a bio " +
        "(Meetup requires a non-empty speaker description)."
    );
  }

  // Opt-in: without includeSpeakerPhoto, avatarUrl is not looked at, so the
  // run (and its log) is what it was before the speaker photo existed.
  const avatarUrl = options.includeSpeakerPhoto
    ? speakerPhotoUrl(options.event, payload, log)
    : undefined;

  if (options.dryRun) {
    log(`--- DRY RUN: would create Meetup draft for ${options.event.id} ---`);
    console.log(JSON.stringify(payload, null, 2));
    if (avatarUrl) {
      log(`--- DRY RUN: would then upload speaker photo ${avatarUrl} and set it via editEvent ---`);
    }
    return { status: "dry-run", payload };
  }

  const client = createMeetupClient(options.credentials);
  log(`Creating Meetup draft: ${options.event.title}`);
  const created = await callCreateEvent(client, payload);
  log(`Created draft id=${created.id} url=${created.eventUrl}`);

  // Both photo uploads need the group's ID; look it up once, on first use.
  let groupId: string | undefined;
  const resolveGroupId = async (): Promise<string> => {
    groupId ??= await getGroupId(client, options.groupUrlname);
    return groupId;
  };

  let photoAttached = false;
  if (options.event.imageUrl) {
    try {
      log(`Uploading featured photo from ${options.event.imageUrl}...`);
      await uploadEventPhoto(client, {
        groupId: await resolveGroupId(),
        eventId: created.id,
        imageUrl: options.event.imageUrl,
        setAsMain: true,
      });
      log("Photo attached.");
      photoAttached = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[warn] Photo upload failed, continuing without it: ${msg}`);
    }
  }

  // The speaker photo goes on after the event exists, never in createEvent
  // itself: a failure here costs only the photo, not the draft or the rest of
  // the speaker profile that createEvent already saved.
  let speakerPhotoAttached = false;
  if (avatarUrl && payload.speakerDetails) {
    try {
      log(`Uploading speaker photo from ${avatarUrl}...`);
      await attachSpeakerPhoto(client, {
        groupId: await resolveGroupId(),
        eventId: created.id,
        avatarUrl,
        speakerDetails: payload.speakerDetails,
      });
      log("Speaker photo attached.");
      speakerPhotoAttached = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[warn] Speaker photo failed, keeping the speaker profile without it: ${msg}`);
    }
  }

  const result = {
    eventId: created.id,
    eventUrl: created.eventUrl,
    photoAttached,
    speakerPhotoAttached,
  };
  if (options.onCreated) {
    await options.onCreated({
      event: options.event,
      groupUrlname: options.groupUrlname,
      result,
    });
  }
  return { status: "created", ...result };
}

/** Frontmatter as read off an event file, including the bookkeeping fields. */
type EventFileFrontmatter = EventFrontmatter & {
  event_id?: string | number;
  meetup_events?: unknown;
};

interface ReadEventFile {
  parsed: matter.GrayMatterFile<string>;
  fm: EventFileFrontmatter;
  event: NormalizedEvent;
}

/**
 * Parse frontmatter without gray-matter's cache. Called with no options,
 * `matter()` hands back the object it cached for that exact content, `data`
 * included, so editing `data` would edit the cache: a second file with the same
 * bytes, read later in the same process, would come back already carrying the
 * first one's `event_id` and be skipped as created. Any options object, even
 * an empty one, bypasses the cache.
 */
function parseFrontmatter(raw: string): matter.GrayMatterFile<string> {
  return matter(raw, {});
}

/**
 * Read an event markdown file and normalize it. No idempotency check here —
 * both file entry points do that themselves, against different scopes (one
 * group vs. a set of them).
 */
function readEventFile(eventFile: string): ReadEventFile {
  if (!fs.existsSync(eventFile)) {
    throw new Error(`Event file not found: ${eventFile}`);
  }

  const parsed = parseFrontmatter(fs.readFileSync(eventFile, "utf8"));
  const fm = parsed.data as EventFileFrontmatter;
  const id = path.basename(eventFile).replace(/\.md$/, "");
  const event = frontmatterToNormalizedEvent(id, fm, stripLeadingHeading(parsed.content));
  return { parsed, fm, event };
}

/** Human-readable reason for skipping a group that is already recorded. */
function alreadyCreatedReason(eventFile: string, entry: PublishedEventRef): string {
  return `${eventFile} already has event_id=${entry.event_id} for group ${entry.group}; nothing to do.`;
}

export interface RecordCreatedGroupEventInput {
  /** Markdown body, as returned by gray-matter. */
  content: string;
  /** Parsed frontmatter. Not mutated; the updated copy goes into the output. */
  data: Record<string, unknown>;
  /** The group + ids just created. */
  entry: PublishedEventRef;
  /** Groups already recorded in this file, in the order they should stay. */
  existing: readonly PublishedEventRef[];
  /**
   * The config's primary group. Only a create in *this* group updates the
   * `event_url` / `event_id` scalars.
   */
  primaryGroup?: string;
}

/**
 * Record one created group event in an event file's frontmatter and return the
 * new file contents. Pure: the caller does the writing, which is what makes
 * the merge testable without a filesystem or a network.
 *
 * The scalars are written **only** for the primary group. Putting a secondary
 * group's id in `event_url` / `event_id` would make a later plain `create` skip
 * the file and so never create the primary event at all, and would point an
 * adopter site's "Register on Meetup" link at the wrong group. `meetup_events`
 * always gets the row, primary or not, and always includes the primary — it is
 * the complete record. Rows already in `data.meetup_events` keep any keys
 * beyond `group` / `event_id` / `event_url` that someone added by hand.
 */
export function recordCreatedGroupEvent(input: RecordCreatedGroupEventInput): string {
  const { content, data, entry, existing, primaryGroup } = input;
  const isPrimary =
    primaryGroup !== undefined && entry.group.toLowerCase() === primaryGroup.toLowerCase();

  const next: Record<string, unknown> = { ...data };
  if (isPrimary) {
    if (entry.event_url !== undefined) next.event_url = entry.event_url;
    next.event_id = entry.event_id;
  }
  next.meetup_events = meetupEventsRows(
    mergeCreatedGroupEvents(existing, entry),
    data.meetup_events,
    entry
  );

  return matter.stringify(content, next);
}

export interface CreateMeetupDraftFromFileOptions {
  /** Path to the event markdown file (cppserbia-style: one event per file). */
  eventFile: string;
  groupUrlname: string;
  venues: VenueMap;
  /** IANA timezone of the group. See `BuildPayloadInput.timezone`. */
  timezone?: string;
  /** Meetup member IDs to list as event hosts. */
  hosts?: number[];
  /** Attach `event.speaker` as Meetup's Pro speaker profile. */
  includeSpeaker?: boolean;
  /** Also attach the speaker's photo. See `CreateMeetupDraftOptions.includeSpeakerPhoto`. */
  includeSpeakerPhoto?: boolean;
  dryRun?: boolean;
  credentials?: MeetupCredentials;
  log?: (message: string) => void;
}

export type CreateMeetupDraftFromFileResult =
  | { status: "skipped"; reason: string }
  | CreateMeetupDraftResult;

/**
 * Convenience wrapper for the file-per-event source pattern. Reads the
 * markdown file, normalizes the frontmatter + (H1-stripped) body into a
 * `NormalizedEvent`, calls `createMeetupDraft`, and writes `event_url` +
 * `event_id` back into the file's frontmatter on success.
 *
 * Idempotent, by two rules checked in this order, both returning
 * `{status: "skipped"}` without calling Meetup:
 *  1. The frontmatter already has a numeric `event_id` — whichever group it
 *     belongs to. This is the v0.3.0 rule and log line, unchanged: the file
 *     says the event exists, and guessing that it exists somewhere else would
 *     risk a duplicate draft, which Meetup cannot roll back.
 *  2. `meetup_events` (written by a multi-group run) records this group.
 *
 * The write-back is the v0.3.0 one — `event_url` and `event_id` — plus, only
 * when the file already has a `meetup_events` list, this group's row in it, so
 * that list stays the complete record. A file without one never gains it.
 */
export async function createMeetupDraftFromFile(
  options: CreateMeetupDraftFromFileOptions
): Promise<CreateMeetupDraftFromFileResult> {
  const log = options.log ?? ((m) => console.error(m));

  const { parsed, fm, event } = readEventFile(options.eventFile);

  if (isEventAlreadyCreated(fm.event_id)) {
    const reason = `${options.eventFile} already has event_id=${fm.event_id}; nothing to do.`;
    log(`[skip] ${reason}`);
    return { status: "skipped", reason };
  }

  // The scalar is not an id, so only `meetup_events` is left to consult (and to
  // validate: a malformed row is an error here too, before any API call).
  const already = createdGroupEvents(fm, {
    assumedGroup: options.groupUrlname,
    source: options.eventFile,
  });
  const recorded = already.get(options.groupUrlname.toLowerCase());
  if (recorded) {
    const reason = alreadyCreatedReason(options.eventFile, recorded);
    log(`[skip] ${reason}`);
    return { status: "skipped", reason };
  }

  return createMeetupDraft({
    event,
    groupUrlname: options.groupUrlname,
    venues: options.venues,
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    ...(options.hosts !== undefined ? { hosts: options.hosts } : {}),
    ...(options.includeSpeaker !== undefined ? { includeSpeaker: options.includeSpeaker } : {}),
    ...(options.includeSpeakerPhoto !== undefined
      ? { includeSpeakerPhoto: options.includeSpeakerPhoto }
      : {}),
    dryRun: options.dryRun,
    credentials: options.credentials,
    log,
    onCreated: async ({ result }) => {
      // Assigning onto a copy keeps the key order v0.3.0 wrote: existing
      // placeholders are replaced in place, missing keys are appended.
      const next: Record<string, unknown> = { ...parsed.data };
      next.event_url = result.eventUrl;
      next.event_id = result.eventId;
      const withList = Array.isArray(next.meetup_events);
      if (withList) {
        const entry: PublishedEventRef = {
          group: options.groupUrlname,
          event_id: result.eventId,
          ...(result.eventUrl !== "" ? { event_url: result.eventUrl } : {}),
        };
        next.meetup_events = meetupEventsRows(
          mergeCreatedGroupEvents([...already.values()], entry),
          next.meetup_events,
          entry
        );
      }
      fs.writeFileSync(options.eventFile, matter.stringify(parsed.content, next));
      log(
        withList
          ? `[updated] ${options.eventFile} with event_url + event_id and its meetup_events entry for ${options.groupUrlname}`
          : `[updated] ${options.eventFile} with event_url + event_id`
      );
    },
  });
}

/**
 * A draft was created on Meetup but could not be recorded wherever the caller
 * keeps its bookkeeping — for `createMeetupDraftsFromFile`, the event file.
 *
 * Thrown from `onCreated`, it stops a `createMeetupDrafts` run on the spot.
 * Every other per-group error is collected and the remaining groups still run;
 * this one is rethrown instead, because carrying on would create each further
 * group's draft unrecorded as well, and with no record the next run would
 * create them all again. Meetup has no rollback, so the message names the
 * draft that exists, for the user to record by hand.
 */
export class DraftNotRecordedError extends Error {
  override readonly name = "DraftNotRecordedError";
  /** The group the unrecorded draft was created in. */
  readonly groupUrlname: string;
  readonly eventId: string;
  readonly eventUrl: string;

  constructor(
    message: string,
    draft: { groupUrlname: string; eventId: string; eventUrl: string },
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.groupUrlname = draft.groupUrlname;
    this.eventId = draft.eventId;
    this.eventUrl = draft.eventUrl;
  }
}

export interface CreateMeetupDraftsOptions {
  event: NormalizedEvent;
  /**
   * Groups to create the event in, in order, each with its own hosts and its own
   * timezone. The timezone must be per group: Meetup reads `startDateTime` as
   * wall time in the *receiving* group's zone, so one shared wall time would put
   * the event at a different instant in each group.
   */
  groups: Array<{
    urlname: string;
    hosts?: number[];
    includeSpeaker?: boolean;
    includeSpeakerPhoto?: boolean;
    timezone?: string;
  }>;
  venues: VenueMap;
  /**
   * The event date is a true instant (see `BuildPayloadInput.timezone`). With a
   * single group, this is that group's zone when it names none — unless
   * `primaryGroup` says it belongs to another group. With several, it is never
   * applied to them — it would be the wrong zone for all but one — and each
   * group naming no `timezone` has its zone looked up from Meetup before any
   * draft is created. Omit it for the legacy wall-time reading.
   */
  timezone?: string;
  /**
   * The group `timezone` belongs to (the config's `groupUrlname`). With it, a
   * run of one *other* group naming no `timezone` gets that group's zone looked
   * up, exactly as in a multi-group run, rather than the primary's zone. Without
   * it, a run of one group falls back to `timezone` whichever group it is.
   */
  primaryGroup?: string;
  dryRun?: boolean;
  credentials?: MeetupCredentials;
  log?: (message: string) => void;
  onCreated?: CreateMeetupDraftOptions["onCreated"];
}

export type CreateMeetupDraftsResult = {
  results: Array<
    { groupUrlname: string } & (
      | { ok: true; result: CreateMeetupDraftResult }
      | { ok: false; error: string }
    )
  >;
};

/**
 * Create the same event as a Draft in several groups — the Meetup Pro network
 * case, where one session is cross-posted to every group in the network.
 *
 * Meetup's native alternative is `CreateEventInput.proNetworkEvents`, which
 * propagates one event across a network via a saved `filterId`. That filter
 * cannot be enumerated through the API, so which groups it would reach is
 * unverifiable from code; creating one event per named group is explicit,
 * and each draft can be inspected or deleted on its own.
 *
 * Groups are processed **sequentially** — a partial failure must not race — and
 * one group failing does not stop the rest. Every outcome is reported, so the
 * caller can retry only the groups that failed. There is no cross-group
 * rollback: on partial failure the drafts that succeeded stay. The one
 * exception is a `DraftNotRecordedError` from `onCreated`, which is rethrown at
 * once, with no further group attempted.
 *
 * Timezones are settled first, though: when `timezone` is set and several
 * groups are given (or one group other than `primaryGroup`), every group
 * without its own `timezone` is looked up from Meetup before anything is
 * created, and a failed lookup (or a dry run, which makes no API calls) throws
 * with no draft created.
 */
export async function createMeetupDrafts(
  options: CreateMeetupDraftsOptions
): Promise<CreateMeetupDraftsResult> {
  const log = options.log ?? ((m) => console.error(m));
  if (options.groups.length === 0) {
    throw new Error("createMeetupDrafts called with no groups.");
  }

  const timezones = await resolveDraftTimezones(options, log);

  const results: CreateMeetupDraftsResult["results"] = [];
  for (const [index, group] of options.groups.entries()) {
    log(`[${index + 1}/${options.groups.length}] ${group.urlname}`);
    const timezone = timezones[index];
    try {
      const result = await createMeetupDraft({
        event: options.event,
        groupUrlname: group.urlname,
        venues: options.venues,
        ...(timezone !== undefined ? { timezone } : {}),
        ...(group.hosts !== undefined ? { hosts: group.hosts } : {}),
        ...(group.includeSpeaker !== undefined ? { includeSpeaker: group.includeSpeaker } : {}),
        ...(group.includeSpeakerPhoto !== undefined
          ? { includeSpeakerPhoto: group.includeSpeakerPhoto }
          : {}),
        ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
        log,
        ...(options.onCreated !== undefined ? { onCreated: options.onCreated } : {}),
      });
      results.push({ groupUrlname: group.urlname, ok: true, result });
    } catch (err) {
      // A draft that exists but is not recorded: stop rather than make more.
      if (err instanceof DraftNotRecordedError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      log(`[error] ${group.urlname}: ${error}`);
      results.push({ groupUrlname: group.urlname, ok: false, error });
    }
  }

  const failed = results.filter((r) => !r.ok);
  const failedNote =
    failed.length > 0 ? `; failed: ${failed.map((f) => f.groupUrlname).join(", ")}` : "";
  log(`Done: ${results.length - failed.length}/${results.length} group(s) succeeded${failedNote}`);
  return { results };
}

/**
 * The timezone each group's wall time is written in, aligned with
 * `options.groups`.
 *
 * A group's own `timezone` always wins. Otherwise, with no `options.timezone`,
 * or a single group that is the primary (or any single group, when no
 * `primaryGroup` is given), it falls back to `options.timezone` as before (unset
 * being the legacy wall-time reading). A shared timezone is right for one group
 * at most, so everywhere else the groups naming no zone get the one Meetup
 * holds for them instead.
 */
async function resolveDraftTimezones(
  options: CreateMeetupDraftsOptions,
  log: (message: string) => void
): Promise<Array<string | undefined>> {
  const { groups, timezone: shared, primaryGroup } = options;
  const [only] = groups;
  const sharedIsTheGroups =
    groups.length === 1 &&
    only !== undefined &&
    (primaryGroup === undefined || only.urlname.toLowerCase() === primaryGroup.toLowerCase());
  if (shared === undefined || sharedIsTheGroups) {
    return groups.map((g) => g.timezone ?? shared);
  }

  const missing = groups.filter((g) => g.timezone === undefined).map((g) => g.urlname);
  const lookedUp = await lookUpGroupTimezones(missing, options, log);
  return groups.map((g) => g.timezone ?? lookedUp.get(g.urlname.toLowerCase()));
}

/**
 * Ask Meetup for each group's timezone, all or nothing: any group that cannot
 * be resolved throws before a single draft exists, so a lookup failure never
 * leaves a partial run behind. Returns zones keyed by lowercased urlname.
 */
async function lookUpGroupTimezones(
  urlnames: string[],
  options: Pick<CreateMeetupDraftsOptions, "dryRun" | "credentials">,
  log: (message: string) => void
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  // Meetup urlnames are case-insensitive: one lookup per group, however spelled.
  const unique = urlnames.filter(
    (u, i) => urlnames.findIndex((v) => v.toLowerCase() === u.toLowerCase()) === i
  );
  if (unique.length === 0) return found;

  const quote = (list: string[]) => list.map((u) => JSON.stringify(u)).join(", ");
  const pinHint = (list: string[]) =>
    `Add meetup.groupTimezones entries for ${quote(list)} (run \`coopkit-meetup list-groups\` to print them)`;

  if (options.dryRun) {
    const one = unique.length === 1;
    throw new Error(
      [
        `Dry run cannot look up the timezone of ${quote(unique)}: it makes no Meetup API calls,`,
        one
          ? "and that group needs its own timezone: the shared one is not applied to it."
          : "and a multi-group run needs each group's own timezone.",
        `${pinHint(unique)}, or run without --dry-run to look ${one ? "it" : "them"} up.`,
      ].join(" ")
    );
  }

  const failures: Array<{ urlname: string; reason: string }> = [];
  let client: MeetupClient | undefined;
  try {
    client = createMeetupClient(options.credentials);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const urlname of unique) failures.push({ urlname, reason });
  }

  if (client) {
    for (const urlname of unique) {
      try {
        const info = await fetchGroupInfo(client, urlname);
        if (info.timezone) found.set(urlname.toLowerCase(), info.timezone);
        else failures.push({ urlname, reason: "Meetup returned none" });
      } catch (err) {
        failures.push({ urlname, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  if (failures.length > 0) {
    // One cause shared by every group (no credentials, a rejected token) is said once.
    const clean = (reason: string) => reason.trim().replace(/\.$/, "");
    const failed = failures.map((f) => f.urlname);
    const reasons = new Set(failures.map((f) => clean(f.reason)));
    const detail =
      reasons.size === 1
        ? `${quote(failed)} (${[...reasons][0]})`
        : failures.map((f) => `${JSON.stringify(f.urlname)} (${clean(f.reason)})`).join(", ");
    throw new Error(
      `No drafts were created: could not get the timezone of ${detail} from Meetup. ${pinHint(failed)}.`
    );
  }

  for (const urlname of unique) {
    const timezone = found.get(urlname.toLowerCase());
    log(
      `[info] Using Meetup's timezone for ${urlname}: ${timezone} (pin it with meetup.groupTimezones)`
    );
  }
  return found;
}

export interface CreateMeetupDraftsFromFileOptions {
  /** Path to the event markdown file (cppserbia-style: one event per file). */
  eventFile: string;
  /** Groups to create the event in, in order. Same shape as `createMeetupDrafts`. */
  groups: CreateMeetupDraftsOptions["groups"];
  /**
   * The config's primary group — the only one whose ids are mirrored into the
   * `event_url` / `event_id` scalars, the group a legacy scalar pair without a
   * readable `event_url` is attributed to, and the group `timezone` belongs to.
   * Deliberately independent of `groups`, so "primary" never depends on which
   * groups a given run happened to select. Required: without it a numeric
   * `event_id` could be unattributable, and ignoring it could duplicate a draft.
   */
  primaryGroup: string;
  /**
   * Every group the config names (primary and `groups`), when it is wider than
   * this run's `groups`. A legacy `event_url` naming one of them is attributed
   * to it; one naming a group outside this list, `groups` and `primaryGroup` is
   * refused, since it may be an old urlname of a group this run would create in.
   */
  configuredGroups?: readonly string[];
  venues: VenueMap;
  /**
   * The config's `meetup.timezone`, the primary group's zone. As in
   * `createMeetupDrafts`: the fallback when the primary alone is requested;
   * otherwise the groups naming no zone of their own are looked up on Meetup.
   */
  timezone?: string;
  dryRun?: boolean;
  credentials?: MeetupCredentials;
  log?: (message: string) => void;
}

export type CreateMeetupDraftsFromFileResult = {
  results: Array<
    { groupUrlname: string } & (
      | { ok: true; result: CreateMeetupDraftFromFileResult }
      | { ok: false; error: string }
    )
  >;
};

/**
 * Create the event described by one markdown file as a Draft in several groups
 * — the file-per-event counterpart of `createMeetupDrafts`.
 *
 * Idempotent **per group**: `meetup_events` in the frontmatter records every
 * group the event exists in, and a recorded group is reported as
 * `{status: "skipped"}` without any API call. That makes a retry after a
 * partial failure safe — it recreates only the groups that are missing.
 *
 * A legacy `event_url` / `event_id` pair counts for the group its URL names,
 * or for `primaryGroup` when the URL names none. A URL naming a group this run
 * does not know (neither `primaryGroup`, `groups` nor `configuredGroups`) is an
 * error before anything is created: it may be a renamed urlname of one of the
 * groups, and guessing wrong would duplicate that group's draft.
 *
 * The file is written back **inside** `onCreated`, once per group, so a failure
 * halfway through still leaves the successful groups recorded on disk. If that
 * write fails, the run stops at once with a `DraftNotRecordedError` naming the
 * draft that was just created, and no further group is attempted: each one
 * would be created unrecorded too. When every requested group is already
 * recorded, this returns before constructing a client or touching the file, so
 * "the file did not change" keeps meaning "no work was done".
 */
export async function createMeetupDraftsFromFile(
  options: CreateMeetupDraftsFromFileOptions
): Promise<CreateMeetupDraftsFromFileResult> {
  const log = options.log ?? ((m) => console.error(m));
  const { parsed, fm, event } = readEventFile(options.eventFile);

  // Meetup urlnames are case-insensitive, so asking for the same group twice
  // under different casing must still create exactly one draft.
  const requested: CreateMeetupDraftsFromFileOptions["groups"] = [];
  const seen = new Set<string>();
  for (const group of options.groups) {
    const key = group.urlname.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    requested.push(group);
  }

  const bookkeeping = {
    assumedGroup: options.primaryGroup,
    knownGroups: [...requested.map((g) => g.urlname), ...(options.configuredGroups ?? [])],
    source: options.eventFile,
  };
  let already = createdGroupEvents(fm, bookkeeping);

  const byGroup = new Map<string, CreateMeetupDraftsFromFileResult["results"][number]>();
  const todo: CreateMeetupDraftsFromFileOptions["groups"] = [];
  for (const group of requested) {
    const recorded = already.get(group.urlname.toLowerCase());
    if (recorded) {
      const reason = alreadyCreatedReason(options.eventFile, recorded);
      log(`[skip] ${reason}`);
      byGroup.set(group.urlname.toLowerCase(), {
        groupUrlname: group.urlname,
        ok: true,
        result: { status: "skipped", reason },
      });
      continue;
    }
    todo.push(group);
  }

  // Nothing to do: return before `createMeetupDrafts` (which rejects an empty
  // group list), before any client is built, and without writing the file.
  if (todo.length === 0) {
    return { results: requested.map((g) => orderedResult(byGroup, g.urlname)) };
  }

  // A multi-group run stays one when a retry has a single group left, so it
  // settles zones the same way the first attempt did: the remaining groups'
  // zones are settled here, from what was requested rather than from what is
  // left to do. (createMeetupDrafts, given primaryGroup, would already refuse
  // the shared zone for a lone non-primary group; this keeps the primary's
  // zone looked up on a retry too, as it was on the first attempt.)
  let groups = todo;
  if (requested.length > 1 && options.timezone !== undefined) {
    const missing = todo.filter((g) => g.timezone === undefined).map((g) => g.urlname);
    const zones = await lookUpGroupTimezones(missing, options, log);
    groups = todo.map((g) => {
      const timezone = g.timezone ?? zones.get(g.urlname.toLowerCase());
      return timezone !== undefined ? { ...g, timezone } : g;
    });
  }

  let content = parsed.content;
  let data = parsed.data as Record<string, unknown>;

  const created = await createMeetupDrafts({
    event,
    groups,
    venues: options.venues,
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    primaryGroup: options.primaryGroup,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    log,
    onCreated: ({ groupUrlname, result }) => {
      const entry: PublishedEventRef = {
        group: groupUrlname,
        event_id: result.eventId,
        ...(result.eventUrl !== "" ? { event_url: result.eventUrl } : {}),
      };
      try {
        const updated = recordCreatedGroupEvent({
          content,
          data,
          entry,
          existing: [...already.values()],
          primaryGroup: options.primaryGroup,
        });
        fs.writeFileSync(options.eventFile, updated);

        // Re-read our own output so the next group merges onto exactly what is
        // on disk, rather than a hand-maintained copy that could drift.
        const reloaded = parseFrontmatter(updated);
        content = reloaded.content;
        data = reloaded.data as Record<string, unknown>;
        already = createdGroupEvents(data as CreatedEventBookkeeping, bookkeeping);
      } catch (err) {
        throw new DraftNotRecordedError(
          unrecordedDraftMessage(options.eventFile, entry, err),
          { groupUrlname, eventId: result.eventId, eventUrl: result.eventUrl },
          { cause: err }
        );
      }
      log(`[updated] ${options.eventFile} with meetup_events entry for ${groupUrlname}`);
    },
  });

  for (const result of created.results) {
    byGroup.set(result.groupUrlname.toLowerCase(), result);
  }

  return { results: requested.map((g) => orderedResult(byGroup, g.urlname)) };
}

/**
 * What to tell the user when a draft exists but its write-back failed: which
 * draft, why, and the exact row to add so the next run does not create it again.
 */
function unrecordedDraftMessage(eventFile: string, entry: PublishedEventRef, err: unknown): string {
  const reason = (err instanceof Error ? err.message : String(err)).trim().replace(/\.$/, "");
  const at = entry.event_url !== undefined ? ` (${entry.event_url})` : "";
  const row = [
    `  - group: ${entry.group}`,
    `    event_id: '${entry.event_id}'`,
    ...(entry.event_url !== undefined ? [`    event_url: '${entry.event_url}'`] : []),
  ];
  return [
    [
      `Created Meetup draft ${entry.event_id} in group ${entry.group}${at},`,
      `but could not record it in ${eventFile}: ${reason}.`,
      "Stopped before creating the event in any further group.",
      "Record this draft by hand before re-running, or the next run creates it again.",
      "Add to meetup_events:",
    ].join(" "),
    ...row,
  ].join("\n");
}

/** Look up a group's outcome, so results come back in the requested order. */
function orderedResult(
  byGroup: Map<string, CreateMeetupDraftsFromFileResult["results"][number]>,
  urlname: string
): CreateMeetupDraftsFromFileResult["results"][number] {
  return (
    byGroup.get(urlname.toLowerCase()) ?? {
      groupUrlname: urlname,
      ok: false,
      error: "No result reported for this group.",
    }
  );
}
