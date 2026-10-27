import type { NormalizedEvent, PublishedEventRef } from "@coopkit/core";
import { type SpeakerDetailsInput, speakerDetailsFrom } from "./speaker.js";
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
  /** Pro-only speaker profile. Omitted unless the group opts in and a bio exists. */
  speakerDetails?: SpeakerDetailsInput;
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
  /**
   * Attach `event.speaker` as Meetup's Pro speaker profile. Off by default:
   * `speakerDetails` is a Pro-network feature and other groups reject it.
   */
  includeSpeaker?: boolean;
}

const PLACEHOLDER_RE = /^<.*>$/;

export function isEventAlreadyCreated(eventId: unknown): boolean {
  if (eventId === null || eventId === undefined) return false;
  const s = String(eventId).trim();
  if (s === "") return false;
  if (PLACEHOLDER_RE.test(s)) return false;
  return /^\d+$/.test(s);
}

// An optional locale segment (`/en-AU/`, `/de-DE/`, `/fr/`) may precede the
// group: Meetup serves localized event pages under it, and a URL copied from
// one is still that group's event. Backtracking keeps a two-letter group
// urlname (`meetup.com/js/events/1/`) read as the group, not as a locale.
const MEETUP_EVENT_URL_RE =
  /^https?:\/\/(?:www\.)?meetup\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?([^/]+)\/events\/\d+/i;

/**
 * Extract the group urlname from a Meetup event URL
 * (`https://www.meetup.com/<urlname>/events/<id>/`, optionally with a locale
 * segment such as `https://www.meetup.com/en-AU/<urlname>/events/<id>/`).
 *
 * This is what lets a file written before per-group bookkeeping existed still
 * say which group its `event_url` / `event_id` scalars belong to, so no
 * migration step is needed: the legacy pair is attributed to its own group and
 * that group is skipped on the next run.
 */
export function groupUrlnameFromEventUrl(eventUrl: unknown): string | undefined {
  if (typeof eventUrl !== "string") return undefined;
  return MEETUP_EVENT_URL_RE.exec(eventUrl.trim())?.[1];
}

/** The bookkeeping fields `createdGroupEvents` reads out of frontmatter. */
export interface CreatedEventBookkeeping {
  event_id?: string | number;
  event_url?: unknown;
  meetup_events?: unknown;
}

export interface CreatedGroupEventsOptions {
  /**
   * Group to attribute a legacy `event_id` scalar to when `event_url` is
   * missing or is not a Meetup event URL. Typically the config's primary group.
   * Without it, such a scalar cannot be attributed and is an error.
   */
  assumedGroup?: string;
  /**
   * The groups the caller knows about (for a run: the groups it targets and the
   * primary). When given, a legacy scalar whose `event_url` names a group
   * outside this list is an error instead of a record for that group: the URL
   * may carry an old urlname of one of these groups, and guessing wrong creates
   * a duplicate draft. `assumedGroup` always counts as known.
   */
  knownGroups?: readonly string[];
  /** File path (or similar) named in error messages. */
  source?: string;
}

/** One validated `meetup_events` row, with where it came from. */
interface RecordedRow {
  index: number;
  ref: PublishedEventRef;
}

/**
 * Read and validate `meetup_events`, keyed by lower-cased group. Exact
 * duplicates (same group, same `event_id`) collapse into the first row; the
 * same group with two different ids is an error, since only one of them can be
 * the draft that is meant to exist.
 */
function recordedRows(list: unknown, where: string): Map<string, RecordedRow> {
  const rows = new Map<string, RecordedRow>();
  if (list === undefined || list === null) return rows;
  if (!Array.isArray(list)) {
    throw new Error(`meetup_events${where} must be a list of {group, event_id} entries.`);
  }
  for (const [index, raw] of list.entries()) {
    const at = `meetup_events[${index}]${where}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${at} must be an object with \`group\` and \`event_id\`.`);
    }
    const entry = raw as { group?: unknown; event_id?: unknown; event_url?: unknown };
    if (typeof entry.group !== "string" || entry.group.trim() === "") {
      throw new Error(`${at} is missing a non-empty \`group\`.`);
    }
    if (!isEventAlreadyCreated(entry.event_id)) {
      throw new Error(
        `${at} has \`event_id\` ${JSON.stringify(entry.event_id)}, which is not a numeric event id.`
      );
    }
    const group = entry.group.trim();
    const ref: PublishedEventRef = {
      group,
      event_id: String(entry.event_id).trim(),
      ...(typeof entry.event_url === "string" && entry.event_url !== ""
        ? { event_url: entry.event_url }
        : {}),
    };

    const key = group.toLowerCase();
    const earlier = rows.get(key);
    if (earlier === undefined) {
      rows.set(key, { index, ref });
    } else if (earlier.ref.event_id !== ref.event_id) {
      throw new Error(
        [
          `meetup_events[${earlier.index}] and meetup_events[${index}]${where} both record group`,
          `${JSON.stringify(group)}, with different event ids (${earlier.ref.event_id} and ${ref.event_id}).`,
          "Keep the row of the draft that should exist, delete the other row, then re-run.",
        ].join(" ")
      );
    } else if (earlier.ref.event_url === undefined && ref.event_url !== undefined) {
      earlier.ref = { ...earlier.ref, event_url: ref.event_url };
    }
  }
  return rows;
}

/**
 * Which groups this event has already been created in, keyed by **lower-cased**
 * group urlname — Meetup urlnames are case-insensitive, and a Pro network can
 * report a group as `CPPTORONTO` where a config says `cpptoronto`.
 *
 * Reads `meetup_events`, then folds in the legacy `event_url` / `event_id`
 * scalar pair attributed via `groupUrlnameFromEventUrl` (falling back to
 * `options.assumedGroup`). An explicit `meetup_events` entry always wins over
 * the inferred one: a scalar whose `event_id` a row already records is taken as
 * recorded there, and a group that has a row keeps it.
 *
 * Fails closed rather than guessing: a record silently dropped, or given to
 * the wrong group, would silently create a duplicate draft — the exact failure
 * this record exists to prevent. It throws on:
 *  - a malformed `meetup_events` row (no `group`, a non-numeric `event_id`);
 *  - two rows for one group with different `event_id`s;
 *  - a numeric `event_id` scalar it cannot attribute to any group (no Meetup
 *    `event_url` and no `assumedGroup`);
 *  - with `knownGroups`, a scalar whose `event_url` names an unknown group.
 */
export function createdGroupEvents(
  fm: CreatedEventBookkeeping,
  options: CreatedGroupEventsOptions = {}
): Map<string, PublishedEventRef> {
  const where = options.source !== undefined ? ` in ${options.source}` : "";
  const created = new Map<string, PublishedEventRef>();
  for (const [key, row] of recordedRows(fm.meetup_events, where)) created.set(key, row.ref);

  if (!isEventAlreadyCreated(fm.event_id)) return created;

  const eventId = String(fm.event_id).trim();
  if ([...created.values()].some((ref) => ref.event_id === eventId)) return created;

  const urlGroup = groupUrlnameFromEventUrl(fm.event_url);
  const assumed = options.assumedGroup !== "" ? options.assumedGroup : undefined;
  const group = urlGroup ?? assumed;
  const scalar = `event_id=${eventId}${where}`;
  if (group === undefined) {
    throw new Error(
      [
        `${scalar} cannot be attributed to a Meetup group: event_url`,
        `${JSON.stringify(fm.event_url ?? null)} is not a Meetup event URL naming one,`,
        "and no primary group was given to assume. Record it in meetup_events with its",
        "group (or fix event_url), then re-run.",
      ].join(" ")
    );
  }

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (
    urlGroup !== undefined &&
    options.knownGroups !== undefined &&
    !options.knownGroups.some((g) => same(g, urlGroup)) &&
    !(assumed !== undefined && same(assumed, urlGroup))
  ) {
    const known = [...(assumed !== undefined ? [assumed] : []), ...options.knownGroups]
      .filter((g, i, all) => all.findIndex((h) => same(g, h)) === i)
      .map((g) => JSON.stringify(g))
      .join(", ");
    throw new Error(
      [
        `${scalar} has an event_url naming group ${JSON.stringify(urlGroup)}, which is not one of`,
        `${known}. It may be an old urlname of one of them, so it is not guessed at:`,
        "record the event in meetup_events under the group it belongs to",
        `(\`- group: <urlname>\` with \`event_id: '${eventId}'\`), then re-run.`,
      ].join(" ")
    );
  }

  if (!created.has(group.toLowerCase())) {
    created.set(group.toLowerCase(), {
      group,
      event_id: eventId,
      ...(typeof fm.event_url === "string" && fm.event_url !== ""
        ? { event_url: fm.event_url }
        : {}),
    });
  }
  return created;
}

/**
 * The rows to write as `meetup_events`: one per ref in `refs`, in order, each
 * built on the row already in `current` for that group (matched
 * case-insensitively) so that keys a person added — a `note:`, say — survive
 * the rewrite. `group` and `event_id` are always taken from the ref, and so is
 * `event_url` when the ref has one. The row for `refreshed` (a group just
 * created again) also loses a stale `event_url` the ref does not carry.
 */
export function meetupEventsRows(
  refs: readonly PublishedEventRef[],
  current: unknown,
  refreshed?: PublishedEventRef
): Array<Record<string, unknown>> {
  const byGroup = new Map<string, Record<string, unknown>>();
  if (Array.isArray(current)) {
    for (const raw of current) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.group !== "string") continue;
      const key = row.group.trim().toLowerCase();
      const earlier = byGroup.get(key);
      if (earlier === undefined) {
        byGroup.set(key, { ...row });
        continue;
      }
      // An exact duplicate row: keep the first, plus any key only the other has.
      for (const [k, v] of Object.entries(row)) if (!(k in earlier)) earlier[k] = v;
    }
  }

  return refs.map((ref) => {
    // A refreshed row keeps its added keys, but not the url of the draft it replaces.
    const row: Record<string, unknown> = Object.fromEntries(
      Object.entries(byGroup.get(ref.group.toLowerCase()) ?? {}).filter(
        ([key]) => !(ref === refreshed && key === "event_url")
      )
    );
    row.group = ref.group;
    row.event_id = ref.event_id;
    if (ref.event_url !== undefined) row.event_url = ref.event_url;
    return row;
  });
}

/**
 * Insert-or-replace `entry` in `existing`, matching `group`
 * case-insensitively and preserving the existing order. Re-running a group
 * that is already recorded refreshes its row instead of appending a second one.
 */
export function mergeCreatedGroupEvents(
  existing: readonly PublishedEventRef[],
  entry: PublishedEventRef
): PublishedEventRef[] {
  const key = entry.group.toLowerCase();
  const index = existing.findIndex((e) => e.group.toLowerCase() === key);
  if (index === -1) return [...existing, entry];
  const merged = [...existing];
  merged[index] = entry;
  return merged;
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
  if (input.includeSpeaker) {
    const speakerDetails = speakerDetailsFrom(event.speaker);
    if (speakerDetails) payload.speakerDetails = speakerDetails;
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
  options: { timezone?: string; hosts?: number[]; includeSpeaker?: boolean } = {}
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
