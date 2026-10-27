// Multi-group file-per-event tests. Offline: dryRun stops createMeetupDraft
// after building the payload, and the per-group skip happens before any client
// is constructed — one case deliberately runs with dryRun:false to prove it.
// Past dry-run, the cases run against the fake Meetup (testing/fake-meetup.ts),
// which stands in for fetch.
import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import type { MeetupCredentials } from "./client.js";
import {
  type CreateMeetupDraftsFromFileOptions,
  createMeetupDraftsFromFile,
  recordCreatedGroupEvent,
} from "./create-event.js";
import {
  type FakeMeetupOptions,
  createFakeMeetup,
  fakeCredentials,
} from "./testing/fake-meetup.js";
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
function withMeetupEvents(rows: Array<Record<string, string>>): string {
  const parsed = matter(FRONTMATTER);
  return matter.stringify(parsed.content, { ...parsed.data, meetup_events: rows });
}

/** The event file with a legacy `event_url` / `event_id` pair (and optionally rows). */
function withScalars(
  eventUrl: string,
  eventId: string,
  rows?: Array<Record<string, string>>
): string {
  const parsed = matter(FRONTMATTER);
  return matter.stringify(parsed.content, {
    ...parsed.data,
    event_url: eventUrl,
    event_id: eventId,
    ...(rows !== undefined ? { meetup_events: rows } : {}),
  });
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

  it("skips the group named by a locale-prefixed legacy event_url", async () => {
    const file = tempEventFile(
      withScalars("https://www.meetup.com/en-AU/cpp-serbia/events/313413133/", "313413133")
    );
    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: THREE_GROUPS,
      primaryGroup: "chicago-c-cpp-users-group",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });
    expect(statuses(results)).toEqual(["dry-run", "skipped", "dry-run"]);
  });

  it("refuses a legacy event_url naming a group it does not know, before any call", async () => {
    // A renamed urlname: Cpp-Serbia-Old may be cpp-serbia under its old name.
    // Attributing it there or ignoring it are both guesses, and the wrong one
    // duplicates cpp-serbia's draft. dryRun:false, no credentials: it must
    // throw before anything would need them.
    const contents = withScalars("https://www.meetup.com/Cpp-Serbia-Old/events/111/", "111");
    const file = tempEventFile(contents);

    await expect(
      createMeetupDraftsFromFile({
        eventFile: file,
        groups: [{ urlname: "cpp-serbia" }, { urlname: "CPPTORONTO" }],
        primaryGroup: "cpp-serbia",
        venues: VENUES,
        dryRun: false,
        log: quiet,
      })
    ).rejects.toThrow(
      /event_id=111 in .* has an event_url naming group "Cpp-Serbia-Old", which is not one of "cpp-serbia", "CPPTORONTO".*record the event in meetup_events/
    );
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("proceeds once meetup_events records that event under its group", async () => {
    const file = tempEventFile(
      withScalars("https://www.meetup.com/Cpp-Serbia-Old/events/111/", "111", [
        { group: "cpp-serbia", event_id: "111" },
      ])
    );
    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: [{ urlname: "cpp-serbia" }, { urlname: "CPPTORONTO" }],
      primaryGroup: "cpp-serbia",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });
    expect(statuses(results)).toEqual(["skipped", "dry-run"]);
  });

  it("attributes a legacy event_url naming a configured group this run leaves out", async () => {
    const file = tempEventFile(
      withScalars("https://www.meetup.com/cpp-serbia/events/313413133/", "313413133")
    );
    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: [{ urlname: "CPPTORONTO" }],
      primaryGroup: "chicago-c-cpp-users-group",
      configuredGroups: ["chicago-c-cpp-users-group", "cpp-serbia", "CPPTORONTO"],
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });
    expect(statuses(results)).toEqual(["dry-run"]);
  });

  it("attributes a numeric event_id without a usable event_url to the primary group", async () => {
    const file = tempEventFile(withScalars("<Meetup.com Event URL>", "313413133"));
    const { results } = await createMeetupDraftsFromFile({
      eventFile: file,
      groups: THREE_GROUPS,
      primaryGroup: "chicago-c-cpp-users-group",
      venues: VENUES,
      dryRun: true,
      log: quiet,
    });
    expect(statuses(results)).toEqual(["skipped", "dry-run", "dry-run"]);
  });

  it("refuses two meetup_events rows giving one group different ids", async () => {
    const file = tempEventFile(
      withMeetupEvents([
        { group: "cpp-serbia", event_id: "111" },
        { group: "CPP-Serbia", event_id: "222" },
      ])
    );
    await expect(
      createMeetupDraftsFromFile({
        eventFile: file,
        groups: THREE_GROUPS,
        primaryGroup: "chicago-c-cpp-users-group",
        venues: VENUES,
        dryRun: true,
        log: quiet,
      })
    ).rejects.toThrow(
      /meetup_events\[0\] and meetup_events\[1\] in .*event\.md both record group "CPP-Serbia"/
    );
  });

  it("rejects when the event file does not exist", async () => {
    await expect(
      createMeetupDraftsFromFile({
        eventFile: join(tmpdir(), "coopkit-does-not-exist-xyz.md"),
        groups: THREE_GROUPS,
        primaryGroup: "chicago-c-cpp-users-group",
        venues: VENUES,
        dryRun: true,
        log: quiet,
      })
    ).rejects.toThrow(/not found/);
  });
});

describe("createMeetupDraftsFromFile timezones on a retry", () => {
  // The dry-run payloads printed to stdout, one pretty-printed object each.
  async function capturePayloads(
    run: () => Promise<unknown>
  ): Promise<Array<{ groupUrlname: string; startDateTime: string }>> {
    const original = console.log;
    const printed: string[] = [];
    console.log = (message: string) => printed.push(message);
    try {
      await run();
    } finally {
      console.log = original;
    }
    return printed.map((p) => JSON.parse(p));
  }

  const NETWORK = [{ urlname: "chicago-c-cpp-users-group" }, { urlname: "cpp-serbia" }];

  it("still treats a retry with one group left as multi-group", async () => {
    // Chicago was created on the first run; only cpp-serbia is left. The shared
    // timezone is Chicago's, so falling back to it would misplace cpp-serbia's
    // draft: the group's own zone is needed, which a dry run cannot look up.
    const file = tempEventFile(
      withMeetupEvents([{ group: "chicago-c-cpp-users-group", event_id: "313413133" }])
    );

    await expect(
      createMeetupDraftsFromFile({
        eventFile: file,
        groups: NETWORK,
        primaryGroup: "chicago-c-cpp-users-group",
        venues: VENUES,
        timezone: "America/Chicago",
        dryRun: true,
        log: quiet,
      })
    ).rejects.toThrow('Dry run cannot look up the timezone of "cpp-serbia"');
  });

  it("uses the remaining group's own timezone on a retry", async () => {
    const file = tempEventFile(
      withMeetupEvents([{ group: "chicago-c-cpp-users-group", event_id: "313413133" }])
    );

    const payloads = await capturePayloads(() =>
      createMeetupDraftsFromFile({
        eventFile: file,
        groups: [
          { urlname: "chicago-c-cpp-users-group" },
          { urlname: "cpp-serbia", timezone: "Europe/Belgrade" },
        ],
        primaryGroup: "chicago-c-cpp-users-group",
        venues: VENUES,
        timezone: "America/Chicago",
        dryRun: true,
        log: quiet,
      })
    );

    // 18:00Z on 2026-05-09 is 20:00 in Belgrade (CEST), not Chicago's 13:00.
    expect(payloads.map((p) => [p.groupUrlname, p.startDateTime])).toEqual([
      ["cpp-serbia", "2026-05-09T20:00:00"],
    ]);
  });

  it("refuses a dry run of a lone non-primary group: its zone is not the shared one", async () => {
    const file = tempEventFile(FRONTMATTER);
    await expect(
      createMeetupDraftsFromFile({
        eventFile: file,
        groups: [{ urlname: "cpp-serbia" }],
        primaryGroup: "chicago-c-cpp-users-group",
        venues: VENUES,
        timezone: "America/Chicago",
        dryRun: true,
        log: quiet,
      })
    ).rejects.toThrow(
      'Dry run cannot look up the timezone of "cpp-serbia": it makes no Meetup API calls, and that group needs its own timezone'
    );
  });

  it("keeps the shared timezone when only one group was requested", async () => {
    const file = tempEventFile(FRONTMATTER);

    const payloads = await capturePayloads(() =>
      createMeetupDraftsFromFile({
        eventFile: file,
        groups: [{ urlname: "chicago-c-cpp-users-group" }],
        primaryGroup: "chicago-c-cpp-users-group",
        venues: VENUES,
        timezone: "America/Chicago",
        dryRun: true,
        log: quiet,
      })
    );

    // 18:00Z on 2026-05-09 is 13:00 in Chicago (CDT).
    expect(payloads.map((p) => p.startDateTime)).toEqual(["2026-05-09T13:00:00"]);
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

  it("keeps keys a person added to existing rows", () => {
    const updated = matter(
      recordCreatedGroupEvent({
        content: parsed.content,
        data: {
          ...parsed.data,
          meetup_events: [{ group: "cpp-serbia", note: "moved venue", event_id: "313413133" }],
        },
        entry: secondary,
        existing: [{ group: "cpp-serbia", event_id: "313413133" }],
        primaryGroup: "cpp-serbia",
      })
    );
    expect(updated.data.meetup_events).toEqual([
      { group: "cpp-serbia", note: "moved venue", event_id: "313413133" },
      secondary,
    ]);
    // Key order too: the added key stays where the person put it.
    expect(Object.keys(updated.data.meetup_events[0])).toEqual(["group", "note", "event_id"]);
  });

  it("keeps added keys on a row it refreshes, but not its stale event_url", () => {
    const updated = matter(
      recordCreatedGroupEvent({
        content: parsed.content,
        data: { ...parsed.data, meetup_events: [{ ...primary, note: "keep me" }] },
        entry: { group: "cpp-serbia", event_id: "999999999" },
        existing: [primary],
        primaryGroup: "cpp-serbia",
      })
    );
    expect(updated.data.meetup_events).toEqual([
      { group: "cpp-serbia", event_id: "999999999", note: "keep me" },
    ]);
  });

  it("writes one row for exact duplicate rows, with the keys of both", () => {
    const updated = matter(
      recordCreatedGroupEvent({
        content: parsed.content,
        data: {
          ...parsed.data,
          meetup_events: [
            { group: "cpp-serbia", event_id: "313413133", note: "first" },
            { group: "CPP-Serbia", event_id: "313413133", note: "second", by: "alex" },
          ],
        },
        entry: secondary,
        existing: [{ group: "cpp-serbia", event_id: "313413133" }],
        primaryGroup: "cpp-serbia",
      })
    );
    expect(updated.data.meetup_events).toEqual([
      { group: "cpp-serbia", event_id: "313413133", note: "first", by: "alex" },
      secondary,
    ]);
  });
});

describe("createMeetupDraftsFromFile against Meetup", () => {
  const realFetch = globalThis.fetch;
  let credentials: MeetupCredentials;
  let fake: ReturnType<typeof createFakeMeetup>;

  beforeAll(() => {
    credentials = fakeCredentials();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function useFake(options: FakeMeetupOptions = {}): void {
    fake = createFakeMeetup(options);
    globalThis.fetch = fake.fetch;
  }

  function run(file: string, overrides: Partial<CreateMeetupDraftsFromFileOptions> = {}) {
    return createMeetupDraftsFromFile({
      eventFile: file,
      groups: THREE_GROUPS,
      primaryGroup: "chicago-c-cpp-users-group",
      venues: VENUES,
      credentials,
      log: quiet,
      ...overrides,
    });
  }

  const row = (group: string, id: number) => ({
    group,
    event_id: String(id),
    event_url: `https://www.meetup.com/${group}/events/${id}/`,
  });

  it("records every group, each write merged onto the one before it", async () => {
    useFake();
    const file = tempEventFile(FRONTMATTER);

    const { results } = await run(file);

    expect(statuses(results)).toEqual(["created", "created", "created"]);
    const written = matter(readFileSync(file, "utf8"));
    // Lose the re-read between groups and each write would start from the
    // file as first read, keeping only the last group's row.
    expect(written.data.meetup_events).toEqual([
      row("chicago-c-cpp-users-group", 900001),
      row("cpp-serbia", 900002),
      row("CPPTORONTO", 900003),
    ]);
    expect(written.data.event_id).toBe("900001");
    expect(written.data.event_url).toBe(
      "https://www.meetup.com/chicago-c-cpp-users-group/events/900001/"
    );
  });

  it("keeps keys a person added to a row it did not create", async () => {
    useFake();
    const file = tempEventFile(
      withMeetupEvents([{ group: "cpp-serbia", event_id: "313413133", note: "created by hand" }])
    );

    await run(file);

    expect(matter(readFileSync(file, "utf8")).data.meetup_events).toEqual([
      { group: "cpp-serbia", event_id: "313413133", note: "created by hand" },
      row("chicago-c-cpp-users-group", 900001),
      row("CPPTORONTO", 900002),
    ]);
  });

  it("retries only the group that failed, keeping what the first run recorded", async () => {
    useFake({ failCreateEventIn: ["cpp-serbia"] });
    const file = tempEventFile(FRONTMATTER);

    const first = await run(file);

    expect(statuses(first.results)).toEqual(["created", "failed", "created"]);
    expect(matter(readFileSync(file, "utf8")).data.meetup_events).toEqual([
      row("chicago-c-cpp-users-group", 900001),
      row("CPPTORONTO", 900002),
    ]);

    useFake({ firstEventId: 900101 });
    const second = await run(file);

    expect(statuses(second.results)).toEqual(["skipped", "created", "skipped"]);
    expect(fake.inputs("createEvent").map((i) => i.groupUrlname)).toEqual(["cpp-serbia"]);
    const written = matter(readFileSync(file, "utf8"));
    expect(written.data.meetup_events).toEqual([
      row("chicago-c-cpp-users-group", 900001),
      row("CPPTORONTO", 900002),
      row("cpp-serbia", 900101),
    ]);
    expect(written.data.event_id).toBe("900001");
  });

  it("stops at a failed write-back, naming the draft, and creates nothing more", async () => {
    useFake();
    const file = tempEventFile(FRONTMATTER);
    const write = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error(`EACCES: permission denied, open '${file}'`);
    });

    let thrown: unknown;
    try {
      await run(file);
    } catch (err) {
      thrown = err;
    } finally {
      write.mockRestore();
    }

    // The first draft exists but is not on disk: carrying on would create the
    // other two unrecorded as well, and a rerun would duplicate all three.
    expect(fake.inputs("createEvent").map((i) => i.groupUrlname)).toEqual([
      "chicago-c-cpp-users-group",
    ]);
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { eventId?: string; groupUrlname?: string };
    expect(error.name).toBe("DraftNotRecordedError");
    expect(error.eventId).toBe("900001");
    expect(error.groupUrlname).toBe("chicago-c-cpp-users-group");
    expect(error.message).toContain(
      "Created Meetup draft 900001 in group chicago-c-cpp-users-group (https://www.meetup.com/chicago-c-cpp-users-group/events/900001/),"
    );
    expect(error.message).toContain(`but could not record it in ${file}: EACCES`);
    expect(error.message).toContain(
      [
        "  - group: chicago-c-cpp-users-group",
        "    event_id: '900001'",
        "    event_url: 'https://www.meetup.com/chicago-c-cpp-users-group/events/900001/'",
      ].join("\n")
    );
    expect(readFileSync(file, "utf8")).toBe(FRONTMATTER);
  });

  it("looks up a lone non-primary group's timezone rather than use the primary's", async () => {
    useFake({ groupTimezones: { "cpp-serbia": "Europe/Belgrade" } });
    const file = tempEventFile(FRONTMATTER);

    await run(file, { groups: [{ urlname: "cpp-serbia" }], timezone: "America/Chicago" });

    // 18:00Z on 2026-05-09 is 20:00 in Belgrade (CEST), not Chicago's 13:00.
    expect(fake.inputs("createEvent").map((i) => [i.groupUrlname, i.startDateTime])).toEqual([
      ["cpp-serbia", "2026-05-09T20:00:00"],
    ]);
  });

  it("still uses the shared timezone for the primary group alone", async () => {
    useFake();
    const file = tempEventFile(FRONTMATTER);

    await run(file, {
      groups: [{ urlname: "chicago-c-cpp-users-group" }],
      timezone: "America/Chicago",
    });

    expect(fake.ops()).toEqual(["createEvent"]);
    expect(fake.inputs("createEvent")[0]?.startDateTime).toBe("2026-05-09T13:00:00");
  });
});
