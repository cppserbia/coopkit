import fs from "node:fs";
import path from "node:path";
import type { EventFrontmatter, NormalizedEvent } from "@coopkit/core";
import { frontmatterToNormalizedEvent } from "@coopkit/core";
import matter from "gray-matter";
import {
  createMeetupClient,
  MeetupApiError,
  type MeetupClient,
  type MeetupCredentials,
} from "./client.js";
import {
  buildCreateEventPayload,
  type CreateEventPayload,
  detectContentType,
  isEventAlreadyCreated,
  stripLeadingHeading,
} from "./payload.js";
import { resolveVenueId, type VenueMap } from "./venues.js";

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
  });

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
