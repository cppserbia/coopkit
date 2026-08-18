// Multi-group file-per-event tests. Offline: dryRun stops createMeetupDraft
// after building the payload, and the per-group skip happens before any client
// is constructed — one case deliberately runs with dryRun:false to prove it.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { createMeetupDraftsFromFile, recordCreatedGroupEvent } from "./create-event.js";
import type { VenueMap } from "./venues.js";

const VENUES: VenueMap = { online: "online" };

const FRONTMATTER = [
  "---",
  "title: File Event",
  "date: 2026-05-09T18:00:00.000Z",
  "duration: PT2H",
  "venues:",
  "  - online",
  "---",
  "",
  "# File Event",
  "",
  "This is the body.",
].join("\n");

const dirs: string[] = [];
function tempEventFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "coopkit-groups-"));
  dirs.push(dir);
  const file = join(dir, "event.md");
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const quiet = () => {};

/** The event file with an already-recorded `meetup_events` list. */
function withMeetupEvents(rows: Array<{ group: string; event_id: string }>): string {
  const parsed = matter(FRONTMATTER);
  return matter.stringify(parsed.content, { ...parsed.data, meetup_events: rows });
}

function statuses(results: Awaited<ReturnType<typeof createMeetupDraftsFromFile>>["results"]) {
  return results.map((r) => (r.ok ? r.result.status : "failed"));
}

const THREE_GROUPS = [
  { urlname: "chicago-c-cpp-users-group" },
  { urlname: "cpp-serbia" },
  { urlname: "CPPTORONTO" },
];

describe("createMeetupDraftsFromFile (dry-run)", () => {
  it("attempts every group when none is recorded yet, in order", async () => {
    const file = tempEventFile(FRONTMATTER);
    const before = readFileSync(file, "utf8");

    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: THREE_GROUPS,
      primaryGroup: "chicago-c-cpp-users-group",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });

    expect(results.map((r) => r.groupUrlname)).toEqual([
      "chicago-c-cpp-users-group",
      "cpp-serbia",
      "CPPTORONTO",
    ]);
    expect(statuses(results)).toEqual(["dry-run", "dry-run", "dry-run"]);
    // A dry run must not touch the file at all.
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("skips a group already recorded in meetup_events and keeps request order", async () => {
    const file = tempEventFile(withMeetupEvents([{ group: "cpp-serbia", event_id: "313413133" }]));

    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: THREE_GROUPS,
      primaryGroup: "chicago-c-cpp-users-group",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });

    expect(results.map((r) => r.groupUrlname)).toEqual([
      "chicago-c-cpp-users-group",
      "cpp-serbia",
      "CPPTORONTO",
    ]);
    expect(statuses(results)).toEqual(["dry-run", "skipped", "dry-run"]);
    const skipped = results[1];
    const reason = skipped?.ok && skipped.result.status === "skipped" ? skipped.result.reason : "";
    expect(reason).toContain("cpp-serbia");
    expect(reason).toContain("313413133");
  });

  it("matches a recorded group case-insensitively", async () => {
    const file = tempEventFile(withMeetupEvents([{ group: "CPPTORONTO", event_id: "314900001" }]));
    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: [{ urlname: "cpptoronto" }],
      primaryGroup: "chicago-c-cpp-users-group",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });
    expect(statuses(results)).toEqual(["skipped"]);
  });

  it("skips everything without credentials or a client when all groups are recorded", async () => {
    const file = tempEventFile(
      withMeetupEvents([
        { group: "chicago-c-cpp-users-group", event_id: "313413133" },
        { group: "cpp-serbia", event_id: "314900001" },
      ])
    );
    const before = readFileSync(file, "utf8");

    // dryRun:false — reaching Meetup would need credentials this test has none
    // of, so completing at all proves the skip precedes any client use.
    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: [{ urlname: "chicago-c-cpp-users-group" }, { urlname: "cpp-serbia" }],
      primaryGroup: "chicago-c-cpp-users-group",
      venues: VENUES,
      dryRun: false,
      log: quiet,
    });

    expect(statuses(results)).toEqual(["skipped", "skipped"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("attempts a duplicated group only once", async () => {
    const file = tempEventFile(FRONTMATTER);
    const lines: string[] = [];

    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: [{ urlname: "cpp-serbia" }, { urlname: "CPP-Serbia" }],
      primaryGroup: "cpp-serbia",
      venues: VENUES,
      dryRun: true,
      log: (m) => lines.push(m),
    });

    expect(results.map((r) => r.groupUrlname)).toEqual(["cpp-serbia"]);
    expect(lines.filter((l) => l.startsWith("[1/1]")).length).toBe(1);
    expect(lines.some((l) => l.startsWith("[2/"))).toBe(false);
  });

  it("skips the group named by a legacy event_url scalar and attempts the rest", async () => {
    const legacy = FRONTMATTER.replace(
      "duration: PT2H",
      [
        "duration: PT2H",
        "event_url: 'https://www.meetup.com/cpp-serbia/events/313413133/'",
        "event_id: 313413133",
      ].join("\n")
    );
    const file = tempEventFile(legacy);

    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: THREE_GROUPS,
      primaryGroup: "chicago-c-cpp-users-group",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });

    // No migration needed: the scalars alone say the event exists in cpp-serbia.
    expect(statuses(results)).toEqual(["dry-run", "skipped", "dry-run"]);
  });

  it("rejects when the event file does not exist", async () => {
    await expect(
      createMeetupDraftsFromFile({
        eventFile: join(tmpdir(), "coopkit-does-not-exist-xyz.md"),
        groups: THREE_GROUPS,
        venues: VENUES,
        dryRun: true,
        log: quiet,
      })
    ).rejects.toThrow(/not found/);
  });
});

describe("recordCreatedGroupEvent", () => {
  const parsed = matter(FRONTMATTER);
  const primary = {
    group: "cpp-serbia",
    event_id: "313413133",
    event_url: "https://www.meetup.com/cpp-serbia/events/313413133/",
  };
  const secondary = {
    group: "chicago-c-cpp-users-group",
    event_id: "314900001",
    event_url: "https://www.meetup.com/chicago-c-cpp-users-group/events/314900001/",
  };

  it("writes the scalars and one meetup_events row for the primary group", () => {
    const updated = recordCreatedGroupEvent({
      content: parsed.content,
      data: { ...parsed.data },
      entry: primary,
      existing: [],
      primaryGroup: "cpp-serbia",
    });

    // Literally the grep the reusable workflow uses to decide whether the run
    // did any work: a top-level, column-0, single-line event_url scalar.
    expect(updated).toMatch(/^event_url:/m);
    expect(updated.match(/^event_url:/gm)?.length).toBe(1);
    expect(updated).toMatch(/^event_id:/m);

    const written = matter(updated);
    expect(written.data.event_id).toBe("313413133");
    expect(written.data.event_url).toBe(primary.event_url);
    expect(written.data.meetup_events).toEqual([primary]);
    expect(written.content.trim()).toBe(parsed.content.trim());
  });

  it("records a non-primary group without touching the scalars", () => {
    const updated = recordCreatedGroupEvent({
      content: parsed.content,
      data: { ...parsed.data },
      entry: secondary,
      existing: [],
      primaryGroup: "cpp-serbia",
    });

    expect(updated).not.toMatch(/^event_url:/m);
    expect(updated).not.toMatch(/^event_id:/m);
    const written = matter(updated);
    expect(written.data.meetup_events).toEqual([secondary]);
  });

  it("keeps the primary first and the scalars intact when adding a secondary", () => {
    const legacy = matter(
      recordCreatedGroupEvent({
        content: parsed.content,
        data: { ...parsed.data },
        entry: primary,
        existing: [],
        primaryGroup: "cpp-serbia",
      })
    );

    const updated = matter(
      recordCreatedGroupEvent({
        content: legacy.content,
        data: { ...legacy.data },
        entry: secondary,
        existing: [primary],
        primaryGroup: "cpp-serbia",
      })
    );

    expect(updated.data.meetup_events).toEqual([primary, secondary]);
    expect(updated.data.event_id).toBe(primary.event_id);
    expect(updated.data.event_url).toBe(primary.event_url);
  });

  it("replaces rather than appends when the same group is recorded again", () => {
    const refreshed = {
      group: "CPP-Serbia",
      event_id: "999999999",
      event_url: "https://www.meetup.com/cpp-serbia/events/999999999/",
    };
    const updated = matter(
      recordCreatedGroupEvent({
        content: parsed.content,
        data: { ...parsed.data },
        entry: refreshed,
        existing: [primary, secondary],
        primaryGroup: "cpp-serbia",
      })
    );

    expect(updated.data.meetup_events).toEqual([refreshed, secondary]);
    expect(updated.data.event_id).toBe("999999999");
  });
});
