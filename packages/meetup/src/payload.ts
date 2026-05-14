import type { NormalizedEvent } from "@coopkit/core";
import { resolveVenueId, type VenueMap } from "./venues.js";

export interface CreateEventPayload {
  groupUrlname: string;
  title: string;
  description: string;
  startDateTime: string;
  duration: string;
  venueId: string;
  publishStatus: "DRAFT";
}

export interface BuildPayloadInput {
  event: NormalizedEvent;
  groupUrlname: string;
  resolveVenue: (name: string) => number;
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

  return {
    groupUrlname,
    title: event.title,
    description: event.description ?? "",
    startDateTime: naiveIsoString(event.date),
    duration: event.duration,
    venueId: String(resolveVenue(event.venueKey)),
    publishStatus: "DRAFT",
  };
}

/**
 * Convenience wrapper that resolves the venue against the supplied map.
 * Adopters who want direct VenueMap lookup with no extra wiring can use this.
 */
export function buildCreateEventPayloadWithMap(
  event: NormalizedEvent,
  groupUrlname: string,
  venues: VenueMap
): CreateEventPayload {
  return buildCreateEventPayload({
    event,
    groupUrlname,
    resolveVenue: (name) => resolveVenueId(name, venues),
  });
}

export function detectContentType(header: string | null | undefined): "JPEG" | "PNG" | "GIF" {
  const normalized = (header ?? "").toLowerCase();
  if (normalized.includes("png")) return "PNG";
  if (normalized.includes("gif")) return "GIF";
  return "JPEG";
}
