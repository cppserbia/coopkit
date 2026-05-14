import { describe, expect, it } from "bun:test";
import { frontmatterToNormalizedEvent } from "./from-frontmatter.js";
import type { EventFrontmatter } from "./frontmatter.js";

describe("frontmatterToNormalizedEvent", () => {
  const base: EventFrontmatter = {
    title: "My Event",
    date: new Date("2026-05-09T18:00:00Z"),
    duration: "PT2H",
    venues: ["Primary Venue, City, cc", "Backup Venue"],
    imageUrl: "https://example.org/banner.jpg",
    youtube: "https://youtu.be/abc",
    registration_url: "https://example.org/register",
  };

  it("maps required fields", () => {
    const ne = frontmatterToNormalizedEvent("2026-05-09-my-event", base, "body");
    expect(ne.id).toBe("2026-05-09-my-event");
    expect(ne.title).toBe("My Event");
    expect(ne.date).toEqual(base.date);
    expect(ne.description).toBe("body");
  });

  it("uses the first venue as venueKey", () => {
    const ne = frontmatterToNormalizedEvent("id", base, "");
    expect(ne.venueKey).toBe("Primary Venue, City, cc");
  });

  it("omits venueKey when venues is empty or missing", () => {
    expect(
      frontmatterToNormalizedEvent("id", { ...base, venues: [] }, "").venueKey
    ).toBeUndefined();
    expect(
      frontmatterToNormalizedEvent("id", { ...base, venues: undefined }, "").venueKey
    ).toBeUndefined();
  });

  it("renames youtube → recordingUrl and registration_url → registrationUrl", () => {
    const ne = frontmatterToNormalizedEvent("id", base, "");
    expect(ne.recordingUrl).toBe("https://youtu.be/abc");
    expect(ne.registrationUrl).toBe("https://example.org/register");
  });

  it("preserves the original frontmatter + body in raw", () => {
    const ne = frontmatterToNormalizedEvent("id", base, "body text");
    expect(ne.raw).toEqual({ frontmatter: base, body: "body text" });
  });

  it("omits optional fields when missing", () => {
    const minimal: EventFrontmatter = {
      title: "Minimal",
      date: new Date("2026-01-01T00:00:00Z"),
    };
    const ne = frontmatterToNormalizedEvent("id", minimal, "");
    expect(ne.duration).toBeUndefined();
    expect(ne.venueKey).toBeUndefined();
    expect(ne.imageUrl).toBeUndefined();
    expect(ne.recordingUrl).toBeUndefined();
    expect(ne.registrationUrl).toBeUndefined();
  });
});
