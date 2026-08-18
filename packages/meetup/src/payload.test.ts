import { describe, expect, it } from "bun:test";
import type { NormalizedEvent } from "@coopkit/core";
import {
  buildCreateEventPayload,
  detectContentType,
  isEventAlreadyCreated,
  stripLeadingHeading,
  wallTimeInZone,
} from "./payload.js";
import { ONLINE_VENUE_ID, resolveVenueId } from "./venues.js";

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

// A true-UTC instant: 16:00Z is 11:00 in Chicago (CDT, UTC-5) on this date.
const UTC_EVENT: NormalizedEvent = {
  id: "2026-08-22-andy-soffer",
  title: "Refactoring C++ Today",
  date: new Date("2026-08-22T16:00:00Z"),
  duration: "PT1H",
  venueKey: "online",
  description: "A pragmatic survey.",
};

describe("wallTimeInZone", () => {
  it("converts a UTC instant to wall time in the target zone", () => {
    expect(wallTimeInZone(new Date("2026-08-22T16:00:00Z"), "America/Chicago")).toBe(
      "2026-08-22T11:00:00"
    );
  });

  it("handles a zone ahead of UTC", () => {
    expect(wallTimeInZone(new Date("2026-08-14T16:00:00Z"), "Europe/Belgrade")).toBe(
      "2026-08-14T18:00:00"
    );
  });

  it("rolls the date back when the local day differs from the UTC day", () => {
    // 02:00Z on the 23rd is still 21:00 on the 22nd in Chicago.
    expect(wallTimeInZone(new Date("2026-08-23T02:00:00Z"), "America/Chicago")).toBe(
      "2026-08-22T21:00:00"
    );
  });

  it("renders midnight as 00, not 24", () => {
    expect(wallTimeInZone(new Date("2026-08-22T05:00:00Z"), "America/Chicago")).toBe(
      "2026-08-22T00:00:00"
    );
  });

  it("respects the zone's DST offset for the given date", () => {
    // Chicago is UTC-6 (CST) in January, UTC-5 (CDT) in August.
    expect(wallTimeInZone(new Date("2026-01-17T17:00:00Z"), "America/Chicago")).toBe(
      "2026-01-17T11:00:00"
    );
  });

  it("throws a helpful error on an invalid timezone", () => {
    expect(() => wallTimeInZone(new Date(), "Not/AZone")).toThrow(/Invalid timezone/);
  });
});

describe("buildCreateEventPayload timezone handling", () => {
  const resolveVenue = () => ONLINE_VENUE_ID;

  it("treats the date as group-local wall time when no timezone is set (legacy)", () => {
    const payload = buildCreateEventPayload({
      event: UTC_EVENT,
      groupUrlname: "chicago-c-cpp-users-group",
      resolveVenue,
    });
    expect(payload.startDateTime).toBe("2026-08-22T16:00:00");
  });

  it("converts a true-UTC date into group-local wall time when a timezone is set", () => {
    const payload = buildCreateEventPayload({
      event: UTC_EVENT,
      groupUrlname: "chicago-c-cpp-users-group",
      resolveVenue,
      timezone: "America/Chicago",
    });
    expect(payload.startDateTime).toBe("2026-08-22T11:00:00");
  });
});

describe("buildCreateEventPayload hosts", () => {
  const resolveVenue = () => ONLINE_VENUE_ID;

  it("omits eventHosts entirely when no hosts are given", () => {
    const payload = buildCreateEventPayload({
      event: UTC_EVENT,
      groupUrlname: "g",
      resolveVenue,
    });
    expect("eventHosts" in payload).toBe(false);
  });

  it("omits eventHosts when the list is empty", () => {
    const payload = buildCreateEventPayload({
      event: UTC_EVENT,
      groupUrlname: "g",
      resolveVenue,
      hosts: [],
    });
    expect("eventHosts" in payload).toBe(false);
  });

  it("passes member IDs through as eventHosts", () => {
    const payload = buildCreateEventPayload({
      event: UTC_EVENT,
      groupUrlname: "g",
      resolveVenue,
      hosts: [13296813, 256192100],
    });
    expect(payload.eventHosts).toEqual([13296813, 256192100]);
  });

  it("does not alias the caller's array", () => {
    const hosts = [13296813];
    const payload = buildCreateEventPayload({
      event: UTC_EVENT,
      groupUrlname: "g",
      resolveVenue,
      hosts,
    });
    hosts.push(999);
    expect(payload.eventHosts).toEqual([13296813]);
  });
});

describe("resolveVenueId online support", () => {
  it("returns the online sentinel unchanged", () => {
    expect(resolveVenueId("online", { online: ONLINE_VENUE_ID })).toBe("online");
  });

  it("serializes the sentinel into venueId", () => {
    const payload = buildCreateEventPayload({
      event: UTC_EVENT,
      groupUrlname: "g",
      resolveVenue: (name) => resolveVenueId(name, { online: ONLINE_VENUE_ID }),
    });
    expect(payload.venueId).toBe("online");
  });

  it("still rejects a placeholder numeric ID", () => {
    expect(() => resolveVenueId("bad", { bad: 0 })).toThrow(/placeholder ID/);
  });

  it("still resolves a real numeric ID", () => {
    expect(resolveVenueId("Franklin Tap", { "Franklin Tap": 6500002 })).toBe(6500002);
  });
});

describe("buildCreateEventPayload speakerDetails", () => {
  const resolveVenue = () => ONLINE_VENUE_ID;
  const withSpeaker: NormalizedEvent = {
    ...UTC_EVENT,
    speaker: { name: "Andy Soffer", bioMarkdown: "A lapsed mathematician." },
  };

  it("omits speakerDetails unless the group opts in", () => {
    const payload = buildCreateEventPayload({
      event: withSpeaker,
      groupUrlname: "g",
      resolveVenue,
    });
    expect("speakerDetails" in payload).toBe(false);
  });

  it("includes speakerDetails when opted in", () => {
    const payload = buildCreateEventPayload({
      event: withSpeaker,
      groupUrlname: "g",
      resolveVenue,
      includeSpeaker: true,
    });
    expect(payload.speakerDetails).toEqual({
      name: "Andy Soffer",
      description: "A lapsed mathematician.",
    });
  });

  it("omits speakerDetails when opted in but the speaker has no bio", () => {
    const payload = buildCreateEventPayload({
      event: { ...UTC_EVENT, speaker: { name: "Andy Soffer" } },
      groupUrlname: "g",
      resolveVenue,
      includeSpeaker: true,
    });
    expect("speakerDetails" in payload).toBe(false);
  });

  it("omits speakerDetails when opted in but there is no speaker at all", () => {
    const payload = buildCreateEventPayload({
      event: UTC_EVENT,
      groupUrlname: "g",
      resolveVenue,
      includeSpeaker: true,
    });
    expect("speakerDetails" in payload).toBe(false);
  });
});
