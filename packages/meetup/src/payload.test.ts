import { describe, expect, it } from "bun:test";
import type { NormalizedEvent } from "@coopkit/core";
import {
  buildCreateEventPayload,
  detectContentType,
  isEventAlreadyCreated,
  stripLeadingHeading,
} from "./payload.js";
import { resolveVenueId } from "./venues.js";

describe("stripLeadingHeading", () => {
  it("removes a leading '# Title' line", () => {
    expect(stripLeadingHeading("# My Event\n\nHello world")).toBe("Hello world");
  });

  it("trims leading whitespace/newlines from gray-matter content", () => {
    expect(stripLeadingHeading("\n\n# Title\n\nDescription here.")).toBe("Description here.");
  });

  it("leaves body untouched when there is no leading H1", () => {
    expect(stripLeadingHeading("Just a paragraph.\n\n## Sub")).toBe("Just a paragraph.\n\n## Sub");
  });

  it("does not strip deeper headings", () => {
    expect(stripLeadingHeading("## Subheading\nThen content")).toBe("## Subheading\nThen content");
  });

  it("returns empty string when the body is only an H1", () => {
    expect(stripLeadingHeading("# Only title")).toBe("");
  });
});

describe("isEventAlreadyCreated", () => {
  it("is false for null/undefined/empty", () => {
    expect(isEventAlreadyCreated(undefined)).toBe(false);
    expect(isEventAlreadyCreated(null)).toBe(false);
    expect(isEventAlreadyCreated("")).toBe(false);
    expect(isEventAlreadyCreated("   ")).toBe(false);
  });

  it("is false for the template placeholder", () => {
    expect(isEventAlreadyCreated("<Meetup.com Event ID>")).toBe(false);
  });

  it("is true for numeric IDs (string or number)", () => {
    expect(isEventAlreadyCreated("123456789")).toBe(true);
    expect(isEventAlreadyCreated(123456789)).toBe(true);
  });

  it("is false for non-numeric strings", () => {
    expect(isEventAlreadyCreated("abc")).toBe(false);
    expect(isEventAlreadyCreated("12a")).toBe(false);
  });
});

describe("resolveVenueId", () => {
  it("returns the mapped ID for a known venue", () => {
    expect(
      resolveVenueId("Startit Centar, Belgrade, RS", { "Startit Centar, Belgrade, RS": 42 })
    ).toBe(42);
  });

  it("throws with a helpful message for unknown venues", () => {
    expect(() => resolveVenueId("Other Place", { "Known Place": 1 })).toThrowError(/Unknown venue/);
    expect(() => resolveVenueId("Other Place", { "Known Place": 1 })).toThrowError(/"Known Place"/);
  });

  it("throws when the ID is a placeholder zero", () => {
    expect(() => resolveVenueId("Placeholder Venue", { "Placeholder Venue": 0 })).toThrowError(
      /placeholder ID/
    );
  });

  it("guides the user when the map is empty", () => {
    expect(() => resolveVenueId("Anything", {})).toThrowError(/coopkit\.config\.json/);
  });
});

describe("buildCreateEventPayload", () => {
  const resolveVenue = (name: string) => {
    const map: Record<string, number> = { "Test Venue, Beograd, rs": 777 };
    const id = map[name];
    if (id === undefined) throw new Error(`unexpected venue ${name}`);
    return id;
  };

  const baseEvent: NormalizedEvent = {
    id: "test-event",
    title: "Test Event",
    date: new Date("2025-09-18T18:00:00Z"),
    duration: "PT2H",
    venueKey: "Test Venue, Beograd, rs",
    description: "This is the description body.",
  };

  it("builds a well-formed CreateEventInput for a typical event", () => {
    const payload = buildCreateEventPayload({
      event: baseEvent,
      groupUrlname: "cpp-serbia",
      resolveVenue,
    });

    expect(payload).toEqual({
      groupUrlname: "cpp-serbia",
      title: "Test Event",
      description: "This is the description body.",
      startDateTime: "2025-09-18T18:00:00",
      duration: "PT2H",
      venueId: "777",
      publishStatus: "DRAFT",
    });
  });

  it("uses the event description verbatim (callers strip H1 themselves)", () => {
    const payload = buildCreateEventPayload({
      event: { ...baseEvent, description: "# Title\n\nBody" },
      groupUrlname: "cpp-serbia",
      resolveVenue,
    });
    expect(payload.description).toBe("# Title\n\nBody");
  });

  it("defaults description to empty string when missing", () => {
    const payload = buildCreateEventPayload({
      event: { ...baseEvent, description: undefined },
      groupUrlname: "cpp-serbia",
      resolveVenue,
    });
    expect(payload.description).toBe("");
  });

  it("throws when title is missing", () => {
    expect(() =>
      buildCreateEventPayload({
        event: { ...baseEvent, title: "" },
        groupUrlname: "g",
        resolveVenue,
      })
    ).toThrowError(/title/);
  });

  it("throws when date is missing or invalid", () => {
    expect(() =>
      buildCreateEventPayload({
        event: { ...baseEvent, date: undefined as unknown as Date },
        groupUrlname: "g",
        resolveVenue,
      })
    ).toThrowError(/date/);
  });

  it("throws when venueKey is missing", () => {
    expect(() =>
      buildCreateEventPayload({
        event: { ...baseEvent, venueKey: undefined },
        groupUrlname: "g",
        resolveVenue,
      })
    ).toThrowError(/venueKey/);
  });

  it("throws when duration is missing", () => {
    expect(() =>
      buildCreateEventPayload({
        event: { ...baseEvent, duration: undefined },
        groupUrlname: "g",
        resolveVenue,
      })
    ).toThrowError(/duration/);
  });

  it("drops milliseconds from the startDateTime", () => {
    const payload = buildCreateEventPayload({
      event: { ...baseEvent, date: new Date("2025-09-18T18:30:45.123Z") },
      groupUrlname: "cpp-serbia",
      resolveVenue,
    });
    expect(payload.startDateTime).toBe("2025-09-18T18:30:45");
    expect(payload.startDateTime).not.toContain("Z");
    expect(payload.startDateTime).not.toContain(".");
  });
});

describe("detectContentType", () => {
  it("maps image/jpeg to JPEG", () => {
    expect(detectContentType("image/jpeg")).toBe("JPEG");
  });

  it("maps image/png to PNG", () => {
    expect(detectContentType("image/png")).toBe("PNG");
  });

  it("maps image/gif to GIF", () => {
    expect(detectContentType("image/gif")).toBe("GIF");
  });

  it("is case-insensitive", () => {
    expect(detectContentType("Image/PNG")).toBe("PNG");
  });

  it("tolerates a charset suffix", () => {
    expect(detectContentType("image/jpeg; charset=binary")).toBe("JPEG");
  });

  it("defaults to JPEG for missing headers", () => {
    expect(detectContentType(null)).toBe("JPEG");
    expect(detectContentType(undefined)).toBe("JPEG");
    expect(detectContentType("")).toBe("JPEG");
  });

  it("defaults to JPEG for unknown types", () => {
    expect(detectContentType("application/octet-stream")).toBe("JPEG");
  });
});
