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
import { fetchGroupInfo } from "./list-groups.js";
import {
  type CreateEventPayload,
  buildCreateEventPayload,
  detectContentType,
  isEventAlreadyCreated,
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
  /**
   * The event date is a true instant (see `BuildPayloadInput.timezone`). With a
   * single group, this is that group's zone when it names none. With several,
   * it is never applied to them — it would be the wrong zone for all but one —
   * and each group naming no `timezone` has its zone looked up from Meetup
   * before any draft is created. Omit it for the legacy wall-time reading.
   */
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
 *
 * Timezones are settled first, though: when `timezone` is set and several
 * groups are given, every group without its own `timezone` is looked up from
 * Meetup before anything is created, and a failed lookup (or a dry run, which
 * makes no API calls) throws with no draft created.
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

/**
 * The timezone each group's wall time is written in, aligned with
 * `options.groups`.
 *
 * A group's own `timezone` always wins. Otherwise, with a single group or no
 * `options.timezone`, it falls back to `options.timezone` as before (unset
 * being the legacy wall-time reading). A shared timezone across several groups
 * is right for one of them at most, so there the groups naming no zone get the
 * one Meetup holds for them instead.
 */
async function resolveDraftTimezones(
  options: CreateMeetupDraftsOptions,
  log: (message: string) => void
): Promise<Array<string | undefined>> {
  const { groups, timezone: shared } = options;
  if (groups.length === 1 || shared === undefined) {
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
    throw new Error(
      [
        `Dry run cannot look up the timezone of ${quote(unique)}: it makes no Meetup API calls,`,
        `and a multi-group run needs each group's own timezone. ${pinHint(unique)},`,
        "or run without --dry-run to look them up.",
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
