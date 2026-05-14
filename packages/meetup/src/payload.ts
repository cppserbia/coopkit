import type { EventFrontmatter } from "@coopkit/frontmatter";
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
  frontmatter: EventFrontmatter;
  body: string;
  groupUrlname: string;
  resolveVenue: (name: string) => number;
}

const PLACEHOLDER_RE = /^<.*>$/;

export function isEventAlreadyCreated(event_id: unknown): boolean {
  if (event_id === null || event_id === undefined) return false;
  const s = String(event_id).trim();
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
  const { frontmatter, body, groupUrlname, resolveVenue } = input;

  if (!frontmatter.title) {
    throw new Error("Event is missing frontmatter `title`.");
  }
  if (!(frontmatter.date instanceof Date) || Number.isNaN(frontmatter.date.getTime())) {
    throw new Error("Event frontmatter `date` is missing or not a valid date.");
  }
  if (!frontmatter.venues || frontmatter.venues.length === 0) {
    throw new Error("Event is missing frontmatter `venues`.");
  }
  if (!frontmatter.duration) {
    throw new Error("Event is missing frontmatter `duration`.");
  }

  const primaryVenue = frontmatter.venues[0];
  if (!primaryVenue) {
    throw new Error("Event frontmatter `venues[0]` is empty.");
  }

  return {
    groupUrlname,
    title: frontmatter.title,
    description: stripLeadingHeading(body),
    startDateTime: naiveIsoString(frontmatter.date),
    duration: frontmatter.duration,
    venueId: String(resolveVenue(primaryVenue)),
    publishStatus: "DRAFT",
  };
}

/**
 * Convenience wrapper that builds a CreateEventPayload directly from a venue map.
 * Useful when adopters want the default resolveVenueId behavior.
 */
export function buildCreateEventPayloadWithMap(
  frontmatter: EventFrontmatter,
  body: string,
  groupUrlname: string,
  venueMap: VenueMap
): CreateEventPayload {
  return buildCreateEventPayload({
    frontmatter,
    body,
    groupUrlname,
    resolveVenue: (name) => resolveVenueId(name, venueMap),
  });
}

export function detectContentType(header: string | null | undefined): "JPEG" | "PNG" | "GIF" {
  const normalized = (header ?? "").toLowerCase();
  if (normalized.includes("png")) return "PNG";
  if (normalized.includes("gif")) return "GIF";
  return "JPEG";
}
