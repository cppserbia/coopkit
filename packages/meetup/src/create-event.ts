import fs from "node:fs";
import path from "node:path";
import type { EventFrontmatter, NormalizedEvent } from "@coopkit/core";
import { frontmatterToNormalizedEvent } from "@coopkit/core";
import matter from "gray-matter";
import {
  MeetupApiError,
  type MeetupClient,
  type MeetupCredentials,
  createMeetupClient,
} from "./client.js";
import {
  type CreateEventPayload,
  buildCreateEventPayload,
  detectContentType,
  isEventAlreadyCreated,
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
    await options.onCreated({ event: options.event, result });
  }
  return { status: "created", ...result };
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
 * `event_id` back into the file's frontmatter on success. Idempotent: if
 * the frontmatter already contains a numeric `event_id`, returns
 * `{status: "skipped"}` without calling Meetup.
 */
export async function createMeetupDraftFromFile(
  options: CreateMeetupDraftFromFileOptions
): Promise<CreateMeetupDraftFromFileResult> {
  const log = options.log ?? ((m) => console.error(m));

  if (!fs.existsSync(options.eventFile)) {
    throw new Error(`Event file not found: ${options.eventFile}`);
  }

  const raw = fs.readFileSync(options.eventFile, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data as EventFrontmatter & { event_id?: string | number };

  if (isEventAlreadyCreated(fm.event_id)) {
    const reason = `${options.eventFile} already has event_id=${fm.event_id}; nothing to do.`;
    log(`[skip] ${reason}`);
    return { status: "skipped", reason };
  }

  const id = path.basename(options.eventFile).replace(/\.md$/, "");
  const event = frontmatterToNormalizedEvent(id, fm, stripLeadingHeading(parsed.content));

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
      parsed.data.event_url = result.eventUrl;
      parsed.data.event_id = result.eventId;
      fs.writeFileSync(options.eventFile, matter.stringify(parsed.content, parsed.data));
      log(`[updated] ${options.eventFile} with event_url + event_id`);
    },
  });
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
  /** Fallback IANA timezone for groups that name none. See `BuildPayloadInput.timezone`. */
  timezone?: string;
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
 * rollback: on partial failure the drafts that succeeded stay.
 */
export async function createMeetupDrafts(
  options: CreateMeetupDraftsOptions
): Promise<CreateMeetupDraftsResult> {
  const log = options.log ?? ((m) => console.error(m));
  if (options.groups.length === 0) {
    throw new Error("createMeetupDrafts called with no groups.");
  }

  const results: CreateMeetupDraftsResult["results"] = [];
  for (const [index, group] of options.groups.entries()) {
    log(`[${index + 1}/${options.groups.length}] ${group.urlname}`);
    try {
      const result = await createMeetupDraft({
        event: options.event,
        groupUrlname: group.urlname,
        venues: options.venues,
        ...((group.timezone ?? options.timezone) !== undefined
          ? { timezone: (group.timezone ?? options.timezone) as string }
          : {}),
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
