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
import {
  type CreateEventPayload,
  type CreatedEventBookkeeping,
  buildCreateEventPayload,
  createdGroupEvents,
  detectContentType,
  isEventAlreadyCreated,
  mergeCreatedGroupEvents,
  stripLeadingHeading,
} from "./payload.js";
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

async function uploadFeaturedPhoto(
  client: MeetupClient,
  groupId: string,
  eventId: string,
  imageUrl: string
): Promise<void> {
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
      setAsMain: true,
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
  dryRun?: boolean;
  credentials?: MeetupCredentials;
  log?: (message: string) => void;
  /**
   * Invoked once after a successful create (and after the optional photo
   * upload). The adopter persists `eventId` + `eventUrl` wherever their
   * source-of-truth lives — frontmatter, an events.yml, a database, etc.
   */
  onCreated?: (info: {
    event: NormalizedEvent;
    /** The group the event was created in — the caller may be creating in several. */
    groupUrlname: string;
    result: { eventId: string; eventUrl: string; photoAttached: boolean };
  }) => Promise<void> | void;
}

export type CreateMeetupDraftResult =
  | { status: "dry-run"; payload: CreateEventPayload }
  | { status: "created"; eventId: string; eventUrl: string; photoAttached: boolean };

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

  if (options.dryRun) {
    log(`--- DRY RUN: would create Meetup draft for ${options.event.id} ---`);
    console.log(JSON.stringify(payload, null, 2));
    return { status: "dry-run", payload };
  }

  const client = createMeetupClient(options.credentials);
  log(`Creating Meetup draft: ${options.event.title}`);
  const created = await callCreateEvent(client, payload);
  log(`Created draft id=${created.id} url=${created.eventUrl}`);

  let photoAttached = false;
  if (options.event.imageUrl) {
    try {
      log(`Uploading featured photo from ${options.event.imageUrl}...`);
      const groupId = await getGroupId(client, options.groupUrlname);
      await uploadFeaturedPhoto(client, groupId, created.id, options.event.imageUrl);
      log("Photo attached.");
      photoAttached = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[warn] Photo upload failed, continuing without it: ${msg}`);
    }
  }

  const result = { eventId: created.id, eventUrl: created.eventUrl, photoAttached };
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
 * Read an event markdown file and normalize it. No idempotency check here —
 * both file entry points do that themselves, against different scopes (one
 * group vs. a set of them).
 */
function readEventFile(eventFile: string): ReadEventFile {
  if (!fs.existsSync(eventFile)) {
    throw new Error(`Event file not found: ${eventFile}`);
  }

  const parsed = matter(fs.readFileSync(eventFile, "utf8"));
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
 * the complete record.
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
  next.meetup_events = mergeCreatedGroupEvents(existing, entry).map((e) => ({
    group: e.group,
    event_id: e.event_id,
    ...(e.event_url !== undefined ? { event_url: e.event_url } : {}),
  }));

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

  const { parsed, fm, event } = readEventFile(options.eventFile);

  // Same dedup rule as the multi-group entry point, scoped to this one group:
  // a group recorded in `meetup_events` counts as created even when the
  // scalars are empty (they only ever mirror the primary group).
  const already = createdGroupEvents(fm, {
    assumedGroup: options.groupUrlname,
    source: options.eventFile,
  });
  const recorded = already.get(options.groupUrlname.toLowerCase());
  if (recorded) {
    // Keep the original wording when the scalar is what matched, so callers
    // grepping for it (and the existing workflows) see no change.
    const reason =
      isEventAlreadyCreated(fm.event_id) && String(fm.event_id).trim() === recorded.event_id
        ? `${options.eventFile} already has event_id=${fm.event_id}; nothing to do.`
        : alreadyCreatedReason(options.eventFile, recorded);
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

export interface CreateMeetupDraftsFromFileOptions {
  /** Path to the event markdown file (cppserbia-style: one event per file). */
  eventFile: string;
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
    timezone?: string;
  }>;
  /**
   * The config's primary group — the only one whose ids are mirrored into the
   * `event_url` / `event_id` scalars. Deliberately independent of `groups`, so
   * "primary" never depends on which groups a given run happened to select.
   */
  primaryGroup?: string;
  venues: VenueMap;
  /** Fallback IANA timezone for groups that name none. See `BuildPayloadInput.timezone`. */
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
 * The file is written back **inside** `onCreated`, once per group, so a failure
 * halfway through still leaves the successful groups recorded on disk. When
 * every requested group is already recorded, this returns before constructing a
 * client or touching the file, so "the file did not change" keeps meaning "no
 * work was done".
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
    ...(options.primaryGroup !== undefined ? { assumedGroup: options.primaryGroup } : {}),
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

  let content = parsed.content;
  let data = parsed.data as Record<string, unknown>;

  const created = await createMeetupDrafts({
    event,
    groups: todo,
    venues: options.venues,
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    log,
    onCreated: ({ groupUrlname, result }) => {
      const entry: PublishedEventRef = {
        group: groupUrlname,
        event_id: result.eventId,
        ...(result.eventUrl !== "" ? { event_url: result.eventUrl } : {}),
      };
      const updated = recordCreatedGroupEvent({
        content,
        data,
        entry,
        existing: [...already.values()],
        ...(options.primaryGroup !== undefined ? { primaryGroup: options.primaryGroup } : {}),
      });
      fs.writeFileSync(options.eventFile, updated);

      // Re-read our own output so the next group merges onto exactly what is
      // on disk, rather than a hand-maintained copy that could drift.
      const reloaded = matter(updated);
      content = reloaded.content;
      data = reloaded.data as Record<string, unknown>;
      already = createdGroupEvents(data as CreatedEventBookkeeping, bookkeeping);
      log(`[updated] ${options.eventFile} with meetup_events entry for ${groupUrlname}`);
    },
  });

  for (const result of created.results) {
    byGroup.set(result.groupUrlname.toLowerCase(), result);
  }

  return { results: requested.map((g) => orderedResult(byGroup, g.urlname)) };
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
