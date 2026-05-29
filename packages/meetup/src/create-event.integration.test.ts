// Integration tests for the real entry points, exercised in dry-run mode.
// No network, no Meetup credentials: createMeetupDraft short-circuits after
// building the payload when dryRun is true, and the file-source idempotency
// skip happens before any client is constructed. These cover the
// normalize→build pipeline + file I/O that the unit tests bypass.
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent } from "@coopkit/core";
import { createMeetupDraft, createMeetupDraftFromFile } from "./create-event.js";
import type { VenueMap } from "./venues.js";

const VENUES: VenueMap = { "Test Venue, Beograd, rs": 777, online: 42 };

const baseEvent: NormalizedEvent = {
  id: "2026-05-09-test",
  title: "Test Event",
  date: new Date("2026-05-09T18:00:00Z"),
  duration: "PT2H",
  venueKey: "Test Venue, Beograd, rs",
  description: "Body text.",
};

// Track temp files so we can clean up regardless of assertion outcome.
const tempFiles: string[] = [];
function tempEventFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "coopkit-meetup-"));
  const file = join(dir, "event.md");
  writeFileSync(file, contents);
  tempFiles.push(file);
  return file;
}

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    rmSync(f, { force: true });
  }
});

// Silence the package's progress logging during tests.
const quiet = () => {};

describe("createMeetupDraft (dry-run)", () => {
  it("returns a dry-run payload with the venue resolved and DRAFT status", async () => {
    const result = await createMeetupDraft({
      event: baseEvent,
      groupUrlname: "cpp-serbia",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });

    expect(result.status).toBe("dry-run");
    if (result.status !== "dry-run") throw new Error("unreachable");
    expect(result.payload).toEqual({
      groupUrlname: "cpp-serbia",
      title: "Test Event",
      description: "Body text.",
      startDateTime: "2026-05-09T18:00:00",
      duration: "PT2H",
      venueId: "777",
      publishStatus: "DRAFT",
    });
  });

  it("does not call onCreated in dry-run mode", async () => {
    let called = false;
    await createMeetupDraft({
      event: baseEvent,
      groupUrlname: "g",
      venues: VENUES,
      dryRun: true,
      log: quiet,
      onCreated: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  it("throws for an unknown venue key", async () => {
    await expect(
      createMeetupDraft({
        event: { ...baseEvent, venueKey: "Nope" },
        groupUrlname: "g",
        venues: VENUES,
        dryRun: true,
        log: quiet,
      })
    ).rejects.toThrow(/Unknown venue/);
  });

  it("throws when duration is missing", async () => {
    await expect(
      createMeetupDraft({
        event: { ...baseEvent, duration: undefined },
        groupUrlname: "g",
        venues: VENUES,
        dryRun: true,
        log: quiet,
      })
    ).rejects.toThrow(/duration/);
  });
});

describe("createMeetupDraftFromFile (dry-run)", () => {
  const frontmatter = [
    "---",
    "title: File Event",
    "date: 2026-05-09T18:00:00.000Z",
    "duration: PT2H",
    "venues:",
    '  - "Test Venue, Beograd, rs"',
    "---",
    "",
    "# File Event",
    "",
    "This is the body.",
  ].join("\n");

  it("reads frontmatter, strips the leading H1, and resolves the first venue", async () => {
    const file = tempEventFile(frontmatter);
    const result = await createMeetupDraftFromFile({
      eventFile: file,
      groupUrlname: "cpp-serbia",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });

    expect(result.status).toBe("dry-run");
    if (result.status !== "dry-run") throw new Error("unreachable");
    expect(result.payload.title).toBe("File Event");
    expect(result.payload.description).toBe("This is the body.");
    expect(result.payload.venueId).toBe("777");
    expect(result.payload.startDateTime).toBe("2026-05-09T18:00:00");
  });

  it("does not write back to the file in dry-run mode", async () => {
    const file = tempEventFile(frontmatter);
    const before = readFileSync(file, "utf8");
    await createMeetupDraftFromFile({
      eventFile: file,
      groupUrlname: "cpp-serbia",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("skips (no API, no creds) when event_id is already numeric", async () => {
    const withId = frontmatter.replace("duration: PT2H", "duration: PT2H\nevent_id: 314572567");
    const file = tempEventFile(withId);
    const result = await createMeetupDraftFromFile({
      eventFile: file,
      groupUrlname: "cpp-serbia",
      venues: VENUES,
      dryRun: false, // proves the skip happens before any client/credential use
      log: quiet,
    });
    expect(result.status).toBe("skipped");
  });

  it("does NOT skip for the placeholder event_id", async () => {
    const withPlaceholder = frontmatter.replace(
      "duration: PT2H",
      'duration: PT2H\nevent_id: "<Meetup.com Event ID>"'
    );
    const file = tempEventFile(withPlaceholder);
    const result = await createMeetupDraftFromFile({
      eventFile: file,
      groupUrlname: "cpp-serbia",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });
    expect(result.status).toBe("dry-run");
  });

  it("throws when the event file does not exist", async () => {
    await expect(
      createMeetupDraftFromFile({
        eventFile: join(tmpdir(), "coopkit-does-not-exist-xyz.md"),
        groupUrlname: "g",
        venues: VENUES,
        dryRun: true,
        log: quiet,
      })
    ).rejects.toThrow(/not found/);
  });
});
