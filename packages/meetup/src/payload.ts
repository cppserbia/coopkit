import type { NormalizedEvent } from "@coopkit/core";
import { type VenueId, type VenueMap, resolveVenueId } from "./venues.js";

export interface CreateEventPayload {
  groupUrlname: string;
  title: string;
  description: string;
  startDateTime: string;
  duration: string;
  venueId: string;
  publishStatus: "DRAFT";
  /** Meetup member IDs to list as event hosts. Omitted when none are configured. */
  eventHosts?: number[];
}

export interface BuildPayloadInput {
  event: NormalizedEvent;
  groupUrlname: string;
  resolveVenue: (name: string) => VenueId;
  /**
   * IANA timezone of the Meetup group (e.g. "America/Chicago").
   *
   * Meetup interprets `startDateTime` as *wall time in the group's own
   * timezone* — it accepts no offset. That leaves two possible readings of
   * `event.date`, and the two adopter conventions in the wild disagree:
   *
   *  - **timezone set** — `event.date` is a true instant, and it is converted
   *    to wall time in this zone. Use this when your source stores real UTC
   *    (e.g. `date: 2026-08-22T16:00:00Z` meaning 11:00 in Chicago).
   *  - **timezone omitted** — `event.date`'s UTC clock reading is used
   *    verbatim, so `2026-08-14T18:00:00Z` creates an 18:00 local event. This
   *    is the original behaviour, kept as the default for adopters whose
   *    frontmatter already stores local wall time with a nominal `Z`.
   *
   * Getting this wrong shifts the event by the zone's offset, so set it
   * whenever your dates are genuinely UTC.
   */
  timezone?: string;
  /** Meetup member IDs to list as event hosts. */
  hosts?: number[];
}

const PLACEHOLDER_RE = /^<.*>$/;

export function isEventAlreadyCreated(eventId: unknown): boolean {
  if (eventId === null || eventId === undefined) return false;
  const s = String(eventId).trim();
  if (s === "") return false;
  if (PLACEHOLDER_RE.test(s)) return false;
  return /^\d+$/.test(s);
}

export function stripLeadingHeading(body: string): string {
  const trimmed = body.replace(/^\s+/, "");
  if (!trimmed.startsWith("# ")) return trimmed;
  const nl = trimmed.indexOf("\n");
  if (nl === -1) return "";
  return trimmed.slice(nl + 1).replace(/^\s+/, "");
}

function naiveIsoString(date: Date): string {
  return date.toISOString().slice(0, 19);
}

/**
 * Render an instant as `YYYY-MM-DDTHH:mm:ss` wall time in `timeZone`, the
 * format Meetup's `startDateTime` expects. `hourCycle: "h23"` keeps midnight
 * as `00` rather than `24`.
 */
export function wallTimeInZone(date: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid timezone ${JSON.stringify(timeZone)}: ${msg}`);
  }

  const at: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) {
    if (part.type !== "literal") at[part.type] = part.value;
  }
  return `${at.year}-${at.month}-${at.day}T${at.hour}:${at.minute}:${at.second}`;
}

export function buildCreateEventPayload(input: BuildPayloadInput): CreateEventPayload {
  const { event, groupUrlname, resolveVenue } = input;

  if (!event.title) {
    throw new Error("Event is missing `title`.");
  }
  if (!(event.date instanceof Date) || Number.isNaN(event.date.getTime())) {
    throw new Error("Event `date` is missing or not a valid date.");
  }
  if (!event.venueKey) {
    throw new Error("Event is missing `venueKey`.");
  }
  if (!event.duration) {
    throw new Error("Event is missing `duration`.");
  }

  const payload: CreateEventPayload = {
    groupUrlname,
    title: event.title,
    description: event.description ?? "",
    startDateTime: input.timezone
      ? wallTimeInZone(event.date, input.timezone)
      : naiveIsoString(event.date),
    duration: event.duration,
    venueId: String(resolveVenue(event.venueKey)),
    publishStatus: "DRAFT",
  };
  if (input.hosts && input.hosts.length > 0) {
    payload.eventHosts = [...input.hosts];
  }
  return payload;
}

/**
 * Convenience wrapper that resolves the venue against the supplied map.
 * Adopters who want direct VenueMap lookup with no extra wiring can use this.
 */
export function buildCreateEventPayloadWithMap(
  event: NormalizedEvent,
  groupUrlname: string,
  venues: VenueMap,
  options: { timezone?: string; hosts?: number[] } = {}
): CreateEventPayload {
  return buildCreateEventPayload({
    event,
    groupUrlname,
    resolveVenue: (name) => resolveVenueId(name, venues),
    ...options,
  });
}

export function detectContentType(header: string | null | undefined): "JPEG" | "PNG" | "GIF" {
  const normalized = (header ?? "").toLowerCase();
  if (normalized.includes("png")) return "PNG";
  if (normalized.includes("gif")) return "GIF";
  return "JPEG";
}
