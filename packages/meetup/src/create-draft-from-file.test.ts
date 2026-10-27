// The single-group file path: `create <file>` without --groups, which v0.3.0
// adopters run through _meetup-event-draft.yml. Its skip rule and write-back
// must stay exactly v0.3.0's. Past dry-run it runs against the fake Meetup in
// testing/fake-meetup.ts, which stands in for fetch: nothing reaches the network.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeetupCredentials } from "./client.js";
import {
  type CreateMeetupDraftFromFileOptions,
  createMeetupDraftFromFile,
} from "./create-event.js";
import { createFakeMeetup, fakeCredentials } from "./testing/fake-meetup.js";

/** A template-style event file, as v0.3.0 adopters have them: placeholders, no meetup_events. */
function eventFile(frontmatter: string[], title = "File Event"): string {
  return [
    "---",
    `title: ${title}`,
    "date: 2026-05-09T18:00:00.000Z",
    "duration: PT2H",
    ...frontmatter,
    "venues:",
    "  - online",
    "---",
    "",
    `# ${title}`,
    "",
    "This is the body.",
    "",
  ].join("\n");
}

const PLACEHOLDERS = ["event_url: <Meetup.com Event URL>", "event_id: <Meetup.com Event ID>"];

const realFetch = globalThis.fetch;
let credentials: MeetupCredentials;
let fake: ReturnType<typeof createFakeMeetup>;
let logs: string[];
const dirs: string[] = [];

beforeAll(() => {
  credentials = fakeCredentials();
});

beforeEach(() => {
  fake = createFakeMeetup();
  globalThis.fetch = fake.fetch;
  logs = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempEventFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "coopkit-single-"));
  dirs.push(dir);
  const file = join(dir, "2026-05-09-file-event.md");
  writeFileSync(file, contents);
  return file;
}

/** A real (non-dry) run in cpp-serbia against the fake. */
function create(file: string, overrides: Partial<CreateMeetupDraftFromFileOptions> = {}) {
  return createMeetupDraftFromFile({
    eventFile: file,
    groupUrlname: "cpp-serbia",
    venues: { online: "online" },
    credentials,
    log: (m) => logs.push(m),
    ...overrides,
  });
}

describe("createMeetupDraftFromFile skips (the v0.3.0 rule)", () => {
  it("skips a numeric event_id whose event_url names another group, with the v0.3.0 line", async () => {
    // A renamed urlname, or another config's primary: v0.3.0 skipped, and so
    // must this, or the workflow commits a duplicate draft over the scalars.
    const contents = eventFile([
      "event_url: 'https://www.meetup.com/Cpp-Serbia-Old/events/111/'",
      "event_id: '111'",
    ]);
    const file = tempEventFile(contents);

    const result = await create(file);

    const reason = `${file} already has event_id=111; nothing to do.`;
    expect(result).toEqual({ status: "skipped", reason });
    expect(logs).toEqual([`[skip] ${reason}`]);
    expect(fake.calls).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("skips a numeric event_id with no event_url at all", async () => {
    const file = tempEventFile(eventFile(["event_id: 111"]));
    const result = await create(file);
    expect(result).toEqual({
      status: "skipped",
      reason: `${file} already has event_id=111; nothing to do.`,
    });
    expect(fake.calls).toEqual([]);
  });

  it("skips a numeric event_id even when meetup_events does not list this group", async () => {
    const file = tempEventFile(
      eventFile([
        "event_url: 'https://www.meetup.com/chicago-c-cpp-users-group/events/222/'",
        "event_id: '222'",
        "meetup_events:",
        "  - group: chicago-c-cpp-users-group",
        "    event_id: '222'",
      ])
    );
    expect((await create(file)).status).toBe("skipped");
    expect(fake.calls).toEqual([]);
  });

  it("skips a group meetup_events records, when the scalars are still placeholders", async () => {
    const file = tempEventFile(
      eventFile([...PLACEHOLDERS, "meetup_events:", "  - group: CPP-Serbia", "    event_id: '333'"])
    );

    const result = await create(file);

    const reason = `${file} already has event_id=333 for group CPP-Serbia; nothing to do.`;
    expect(result).toEqual({ status: "skipped", reason });
    expect(logs).toEqual([`[skip] ${reason}`]);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a malformed meetup_events before any API call", async () => {
    const file = tempEventFile(
      eventFile([...PLACEHOLDERS, "meetup_events:", "  - group: cpp-serbia", "    event_id: TBD"])
    );
    await expect(create(file)).rejects.toThrow(/meetup_events\[0\] in .* not a numeric event id/);
    expect(fake.calls).toEqual([]);
  });
});

describe("createMeetupDraftFromFile write-back", () => {
  it("writes exactly what v0.3.0 wrote when the file has no meetup_events", async () => {
    const file = tempEventFile(eventFile(PLACEHOLDERS));

    const result = await create(file);

    expect(result).toMatchObject({ status: "created", eventId: "900001" });
    // Byte for byte: the placeholders replaced in place, nothing else touched,
    // and no meetup_events key introduced into a v0.3.0 adopter's file.
    expect(readFileSync(file, "utf8")).toBe(
      eventFile([
        "event_url: 'https://www.meetup.com/cpp-serbia/events/900001/'",
        "event_id: '900001'",
      ])
    );
    expect(logs).toContain(`[updated] ${file} with event_url + event_id`);
  });

  it("appends both scalars, as v0.3.0 did, to a file that has neither", async () => {
    const file = tempEventFile(eventFile([]));

    await create(file);

    const written = readFileSync(file, "utf8");
    expect(written).toBe(
      eventFile([]).replace(
        "  - online\n",
        [
          "  - online",
          "event_url: 'https://www.meetup.com/cpp-serbia/events/900001/'",
          "event_id: '900001'",
          "",
        ].join("\n")
      )
    );
    expect(written).not.toContain("meetup_events");
  });

  it("adds this group's row when the file already has meetup_events, keeping added keys", async () => {
    const file = tempEventFile(
      eventFile([
        ...PLACEHOLDERS,
        "meetup_events:",
        "  - group: chicago-c-cpp-users-group",
        "    event_id: '314900001'",
        "    note: cross-posted by hand",
      ])
    );

    const result = await create(file);

    expect(result).toMatchObject({ status: "created", eventId: "900001" });
    expect(readFileSync(file, "utf8")).toBe(
      eventFile([
        "event_url: 'https://www.meetup.com/cpp-serbia/events/900001/'",
        "event_id: '900001'",
        "meetup_events:",
        "  - group: chicago-c-cpp-users-group",
        "    event_id: '314900001'",
        "    note: cross-posted by hand",
        "  - group: cpp-serbia",
        "    event_id: '900001'",
        "    event_url: 'https://www.meetup.com/cpp-serbia/events/900001/'",
      ])
    );
    expect(logs).toContain(
      `[updated] ${file} with event_url + event_id and its meetup_events entry for cpp-serbia`
    );
  });

  it("fills an empty meetup_events list", async () => {
    const file = tempEventFile(eventFile([...PLACEHOLDERS, "meetup_events: []"]));
    await create(file);
    expect(readFileSync(file, "utf8")).toContain(
      [
        "meetup_events:",
        "  - group: cpp-serbia",
        "    event_id: '900001'",
        "    event_url: 'https://www.meetup.com/cpp-serbia/events/900001/'",
      ].join("\n")
    );
  });
});

describe("gray-matter's parse cache", () => {
  it("creates a second file whose bytes match one created earlier in the process", async () => {
    // gray-matter caches parses by content. Writing the ids into the cached
    // object made a later file with the same bytes look already created.
    const contents = eventFile(PLACEHOLDERS, `Cache Twin ${crypto.randomUUID()}`);
    const first = tempEventFile(contents);
    const second = tempEventFile(contents);

    const a = await create(first);
    const b = await create(second);

    expect(a).toMatchObject({ status: "created", eventId: "900001" });
    expect(b).toMatchObject({ status: "created", eventId: "900002" });
    expect(readFileSync(second, "utf8")).toContain("event_id: '900002'");
  });
});
