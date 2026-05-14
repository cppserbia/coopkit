import fs from "node:fs";
import matter from "gray-matter";
import type { EventFrontmatter } from "@coopkit/frontmatter";
import {
  createMeetupClient,
  MeetupApiError,
  type MeetupClient,
  type MeetupCredentials,
} from "./client.js";
import {
  buildCreateEventPayload,
  detectContentType,
  isEventAlreadyCreated,
  type CreateEventPayload,
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

export interface CreateMeetupEventOptions {
  /** Absolute or cwd-relative path to the event markdown file. */
  eventFile: string;
  /** Meetup group urlname (e.g. "cpp-serbia"). */
  groupUrlname: string;
  /** Mapping of frontmatter venue strings → numeric Meetup venue IDs. */
  venues: VenueMap;
  /** If true, prints the payload and skips the API call. */
  dryRun?: boolean;
  /** Override credentials. Defaults to standard MEETUP_* env vars. */
  credentials?: MeetupCredentials;
  /** Logger. Defaults to console.error so stdout stays clean. */
  log?: (message: string) => void;
}

export type CreateMeetupEventResult =
  | { status: "skipped"; reason: string }
  | { status: "dry-run"; payload: CreateEventPayload }
  | { status: "created"; eventId: string; eventUrl: string; photoAttached: boolean };

/**
 * Create a Meetup.com Draft event from an event markdown file, then patch
 * `event_url` + `event_id` back into the file's frontmatter.
 *
 * Idempotent: if frontmatter already contains a numeric `event_id`, this is a
 * no-op and returns `{status: "skipped"}`.
 */
export async function createMeetupEvent(
  options: CreateMeetupEventOptions
): Promise<CreateMeetupEventResult> {
  const log = options.log ?? ((m) => console.error(m));

  if (!fs.existsSync(options.eventFile)) {
    throw new Error(`Event file not found: ${options.eventFile}`);
  }

  const raw = fs.readFileSync(options.eventFile, "utf8");
  const parsed = matter(raw);
  const frontmatter = parsed.data as EventFrontmatter & { imageUrl?: string };

  if (isEventAlreadyCreated(frontmatter.event_id)) {
    const reason = `${options.eventFile} already has event_id=${frontmatter.event_id}; nothing to do.`;
    log(`[skip] ${reason}`);
    return { status: "skipped", reason };
  }

  const payload = buildCreateEventPayload({
    frontmatter,
    body: parsed.content,
    groupUrlname: options.groupUrlname,
    resolveVenue: (name) => resolveVenueId(name, options.venues),
  });

  if (options.dryRun) {
    log(`--- DRY RUN: would create Meetup draft for ${options.eventFile} ---`);
    console.log(JSON.stringify(payload, null, 2));
    return { status: "dry-run", payload };
  }

  const client = createMeetupClient(options.credentials);
  log(`Creating Meetup draft: ${frontmatter.title}`);
  const event = await callCreateEvent(client, payload);
  log(`Created draft id=${event.id} url=${event.eventUrl}`);

  let photoAttached = false;
  if (frontmatter.imageUrl) {
    try {
      log(`Uploading featured photo from ${frontmatter.imageUrl}...`);
      const groupId = await getGroupId(client, options.groupUrlname);
      await uploadFeaturedPhoto(client, groupId, event.id, frontmatter.imageUrl);
      log("Photo attached.");
      photoAttached = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[warn] Photo upload failed, continuing without it: ${msg}`);
    }
  }

  parsed.data.event_url = event.eventUrl;
  parsed.data.event_id = event.id;
  fs.writeFileSync(options.eventFile, matter.stringify(parsed.content, parsed.data));
  log(`[updated] ${options.eventFile} with event_url + event_id`);

  return {
    status: "created",
    eventId: event.id,
    eventUrl: event.eventUrl,
    photoAttached,
  };
}
