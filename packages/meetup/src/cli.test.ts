// CLI-level tests that spawn the real bin. Dry-run only (no creds, no network):
// verifies arg parsing, config loading, and the --output result file used by
// the GitHub Action to surface event-id / event-url.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "coopkit-cli-"));
}

const CONFIG = JSON.stringify({
  meetup: { groupUrlname: "cpp-serbia", venues: { online: 42 } },
});

const NETWORK_CONFIG = JSON.stringify({
  meetup: { groupUrlname: "cpp-serbia", venues: { online: 42 }, groups: ["CPPTORONTO"] },
});

const EVENT_MARKDOWN = [
  "---",
  "title: Test Event",
  "date: 2026-05-09T16:00:00.000Z",
  "duration: PT1H",
  "venues:",
  "  - online",
  "---",
  "",
  "Body.",
].join("\n");

const EVENT = JSON.stringify({
  id: "2026-05-09-test",
  title: "Test Event",
  date: "2026-05-09T16:00:00Z",
  duration: "PT1H",
  venueKey: "online",
  description: "Body.",
});

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** The dry-run payloads a multi-group run prints, one pretty-printed object each. */
function payloads(stdout: string): Array<{ groupUrlname: string; startDateTime: string }> {
  return stdout
    .trim()
    .split(/\n(?=\{)/)
    .map((chunk) => JSON.parse(chunk));
}

const FAKE_MEETUP = join(import.meta.dir, "testing", "fake-meetup-preload.ts");

/**
 * Run the bin for real, not as a dry run, against the fake Meetup preloaded
 * into the child process (testing/fake-meetup.ts): no network, no secrets.
 */
async function runAgainstFakeMeetup(
  args: string[],
  cwd: string
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", "--preload", FAKE_MEETUP, CLI, ...args], {
    cwd,
    env: { ...process.env, COOPKIT_FAKE_MEETUP: "{}" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stderr };
}

describe("create-from-json --output (dry-run)", () => {
  it("writes a result JSON file and exits 0", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const out = join(dir, "result.json");
      writeFileSync(config, CONFIG);
      writeFileSync(event, EVENT);

      const { code } = await run([
        "create-from-json",
        "--config",
        config,
        "--dry-run",
        "--output",
        out,
        event,
      ]);

      expect(code).toBe(0);
      const result = JSON.parse(readFileSync(out, "utf8"));
      expect(result.status).toBe("dry-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero with a clear error when the config is missing", async () => {
    const dir = scratch();
    try {
      const event = join(dir, "event.json");
      writeFileSync(event, EVENT);
      const { code } = await run([
        "create-from-json",
        "--config",
        join(dir, "nope.json"),
        "--dry-run",
        event,
      ]);
      expect(code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A multi-group config with every group's timezone pinned, so a dry run needs no
// lookup -- see "per-group timezones" in config.test.ts.
const MULTI_CONFIG = JSON.stringify({
  meetup: {
    groupUrlname: "cpp-serbia",
    groups: ["chicago-c-cpp-users-group"],
    venues: { online: 42 },
    groupTimezones: {
      "cpp-serbia": "Europe/Belgrade",
      "chicago-c-cpp-users-group": "America/Chicago",
    },
  },
});

/** Same event, but pointing at a venue key the config does not define. */
const EVENT_BAD_VENUE = JSON.stringify({ ...JSON.parse(EVENT), venueKey: "nope" });

// The network config the v0.3.0 README taught: one `timezone`, several `groups`,
// no `groupTimezones` (which did not exist yet). Adopters running single-group
// creates against it -- the GitHub Action never passes --groups -- must keep working.
const SHARED_TZ_NETWORK_CONFIG = JSON.stringify({
  meetup: {
    groupUrlname: "chicago-c-cpp-users-group",
    timezone: "America/Chicago",
    groups: ["cpp-serbia", "CPPTORONTO"],
    venues: { online: 42 },
  },
});

describe("create-from-json with a shared-timezone network config", () => {
  it("creates in groupUrlname alone without --groups, converting with meetup.timezone", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const out = join(dir, "result.json");
      writeFileSync(config, SHARED_TZ_NETWORK_CONFIG);
      writeFileSync(event, EVENT);

      const { code, stdout } = await run([
        "create-from-json",
        "--config",
        config,
        "--dry-run",
        "--output",
        out,
        event,
      ]);

      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ status: "dry-run" });
      const payload = JSON.parse(stdout);
      expect(payload.groupUrlname).toBe("chicago-c-cpp-users-group");
      // 16:00Z on 2026-05-09 is 11:00 in Chicago (CDT).
      expect(payload.startDateTime).toBe("2026-05-09T11:00:00");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a dry multi-group run that would need a timezone lookup", async () => {
    // A real run looks the zones up from Meetup (see create-drafts.test.ts);
    // a dry run makes no API calls, so it must say so rather than guess.
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const out = join(dir, "result.json");
      writeFileSync(config, SHARED_TZ_NETWORK_CONFIG);
      writeFileSync(event, EVENT);

      const { code, stdout, stderr } = await run([
        "create-from-json",
        "--groups",
        "all",
        "--config",
        config,
        "--dry-run",
        "--output",
        out,
        event,
      ]);

      expect(code).not.toBe(0);
      expect(stderr).toContain(
        'Dry run cannot look up the timezone of "chicago-c-cpp-users-group", "cpp-serbia", "CPPTORONTO"'
      );
      expect(stderr).toContain("or run without --dry-run to look them up.");
      expect(stdout).toBe("");
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-runs every group once groupTimezones pins them, one instant in each", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const pinned = JSON.parse(SHARED_TZ_NETWORK_CONFIG);
      pinned.meetup.groupTimezones = {
        "chicago-c-cpp-users-group": "America/Chicago",
        "cpp-serbia": "Europe/Belgrade",
        CPPTORONTO: "America/Toronto",
      };
      writeFileSync(config, JSON.stringify(pinned));
      writeFileSync(event, EVENT);

      const { code, stdout } = await run([
        "create-from-json",
        "--groups",
        "all",
        "--config",
        config,
        "--dry-run",
        event,
      ]);

      expect(code).toBe(0);
      // 16:00Z on 2026-05-09: CDT -5, CEST +2, EDT -4.
      expect(payloads(stdout).map((p) => [p.groupUrlname, p.startDateTime])).toEqual([
        ["chicago-c-cpp-users-group", "2026-05-09T11:00:00"],
        ["cpp-serbia", "2026-05-09T18:00:00"],
        ["CPPTORONTO", "2026-05-09T12:00:00"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps converting a narrowed single-group --groups run with meetup.timezone", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      writeFileSync(config, SHARED_TZ_NETWORK_CONFIG);
      writeFileSync(event, EVENT);

      const { code, stdout } = await run([
        "create-from-json",
        "--groups",
        "chicago-c-cpp-users-group",
        "--config",
        config,
        "--dry-run",
        event,
      ]);

      expect(code).toBe(0);
      expect(payloads(stdout).map((p) => [p.groupUrlname, p.startDateTime])).toEqual([
        ["chicago-c-cpp-users-group", "2026-05-09T11:00:00"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("exit codes", () => {
  it("exits 1 when a group in a multi-group run fails", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const out = join(dir, "result.json");
      writeFileSync(config, MULTI_CONFIG);
      // An unknown venue throws inside the per-group try, so every group fails
      // while the run itself completes -- no network, no credentials needed.
      writeFileSync(event, EVENT_BAD_VENUE);

      const { code } = await run([
        "create-from-json",
        "--groups",
        "all",
        "--dry-run",
        "--config",
        config,
        "--output",
        out,
        event,
      ]);

      expect(code).toBe(1);
      expect(JSON.parse(readFileSync(out, "utf8")).status).toBe("partial");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 when every group in a multi-group run succeeds", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const out = join(dir, "result.json");
      writeFileSync(config, MULTI_CONFIG);
      writeFileSync(event, EVENT);

      const { code } = await run([
        "create-from-json",
        "--groups",
        "all",
        "--dry-run",
        "--config",
        config,
        "--output",
        out,
        event,
      ]);

      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8")).status).toBe("dry-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** An event whose speaker has a bio and a headshot, plus a featured banner. */
const EVENT_WITH_SPEAKER = JSON.stringify({
  ...JSON.parse(EVENT),
  imageUrl: "https://images.fake.test/banner.png",
  speaker: {
    name: "Andy Soffer",
    bioMarkdown: "A lapsed mathematician turned software engineer.",
    avatarUrl: "https://images.fake.test/andy-soffer.png",
  },
});

describe("--output after a real create", () => {
  it("adds speakerPhotoAttached to the single-group result", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const out = join(dir, "result.json");
      writeFileSync(
        config,
        JSON.stringify({
          meetup: {
            groupUrlname: "cpp-serbia",
            venues: { online: 42 },
            speakerDetails: true,
            speakerPhoto: true,
          },
        })
      );
      writeFileSync(event, EVENT_WITH_SPEAKER);

      const { code } = await runAgainstFakeMeetup(
        ["create-from-json", "--config", config, "--output", out, event],
        dir
      );

      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
        status: "created",
        eventId: "900001",
        eventUrl: "https://www.meetup.com/cpp-serbia/events/900001/",
        photoAttached: true,
        speakerPhotoAttached: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds speakerPhotoAttached to each group of a multi-group result", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const out = join(dir, "result.json");
      const multi = JSON.parse(MULTI_CONFIG);
      multi.meetup.speakerDetails = ["cpp-serbia"];
      multi.meetup.speakerPhoto = ["cpp-serbia"];
      writeFileSync(config, JSON.stringify(multi));
      writeFileSync(event, EVENT_WITH_SPEAKER);

      const { code } = await runAgainstFakeMeetup(
        ["create-from-json", "--groups", "all", "--config", config, "--output", out, event],
        dir
      );

      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
        status: "created",
        groups: [
          {
            groupUrlname: "cpp-serbia",
            ok: true,
            status: "created",
            eventId: "900001",
            eventUrl: "https://www.meetup.com/cpp-serbia/events/900001/",
            photoAttached: true,
            speakerPhotoAttached: true,
          },
          {
            groupUrlname: "chicago-c-cpp-users-group",
            ok: true,
            status: "created",
            eventId: "900002",
            eventUrl: "https://www.meetup.com/chicago-c-cpp-users-group/events/900002/",
            photoAttached: true,
            speakerPhotoAttached: false,
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("speakerPhoto is opt-in", () => {
  const SPEAKER_CONFIG = {
    groupUrlname: "cpp-serbia",
    venues: { online: 42 },
    speakerDetails: true,
  };

  it("leaves the headshot alone when speakerPhoto is absent", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const out = join(dir, "result.json");
      writeFileSync(config, JSON.stringify({ meetup: SPEAKER_CONFIG }));
      writeFileSync(event, EVENT_WITH_SPEAKER);

      const { code, stderr } = await runAgainstFakeMeetup(
        ["create-from-json", "--config", config, "--output", out, event],
        dir
      );

      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
        status: "created",
        photoAttached: true,
        speakerPhotoAttached: false,
      });
      expect(stderr).toContain("Photo attached.");
      expect(stderr).not.toMatch(/speaker photo/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows a speakerPhoto list per group", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      const out = join(dir, "result.json");
      const multi = JSON.parse(MULTI_CONFIG);
      multi.meetup.speakerDetails = true;
      multi.meetup.speakerPhoto = ["CHICAGO-C-CPP-USERS-GROUP"];
      writeFileSync(config, JSON.stringify(multi));
      writeFileSync(event, EVENT_WITH_SPEAKER);

      const { code, stderr } = await runAgainstFakeMeetup(
        ["create-from-json", "--groups", "all", "--config", config, "--output", out, event],
        dir
      );

      expect(code).toBe(0);
      const { groups } = JSON.parse(readFileSync(out, "utf8"));
      expect(
        groups.map((g: { groupUrlname: string; speakerPhotoAttached: boolean }) => [
          g.groupUrlname,
          g.speakerPhotoAttached,
        ])
      ).toEqual([
        ["cpp-serbia", false],
        ["chicago-c-cpp-users-group", true],
      ]);
      expect(stderr.match(/Uploading speaker photo/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds the dry-run photo line only when opted in", async () => {
    const dir = scratch();
    try {
      const event = join(dir, "event.json");
      writeFileSync(event, EVENT_WITH_SPEAKER);
      const line =
        "--- DRY RUN: would then upload speaker photo https://images.fake.test/andy-soffer.png and set it via editEvent ---";

      const stderrFor = async (meetup: object): Promise<string> => {
        const config = join(dir, "coopkit.config.json");
        writeFileSync(config, JSON.stringify({ meetup }));
        const { code, stderr } = await run([
          "create-from-json",
          "--config",
          config,
          "--dry-run",
          event,
        ]);
        expect(code).toBe(0);
        return stderr;
      };

      const without = await stderrFor(SPEAKER_CONFIG);
      const withPhoto = await stderrFor({ ...SPEAKER_CONFIG, speakerPhoto: true });

      expect(without).not.toMatch(/speaker photo/i);
      expect(withPhoto).toBe(`${without}${line}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a config with speakerPhoto but no speakerDetails", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const event = join(dir, "event.json");
      writeFileSync(
        config,
        JSON.stringify({
          meetup: { groupUrlname: "cpp-serbia", venues: { online: 42 }, speakerPhoto: true },
        })
      );
      writeFileSync(event, EVENT_WITH_SPEAKER);

      const { code, stderr } = await run([
        "create-from-json",
        "--config",
        config,
        "--dry-run",
        event,
      ]);

      expect(code).not.toBe(0);
      expect(stderr).toContain("meetup.speakerPhoto covers");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("create --groups (dry-run)", () => {
  it("reports every group in the config and leaves the file untouched", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const eventFile = join(dir, "2026-05-09-test.md");
      const out = join(dir, "result.json");
      writeFileSync(config, NETWORK_CONFIG);
      writeFileSync(eventFile, EVENT_MARKDOWN);

      const { code } = await run([
        "create",
        "--config",
        config,
        "--groups",
        "all",
        "--dry-run",
        "--output",
        out,
        eventFile,
      ]);

      expect(code).toBe(0);
      const result = JSON.parse(readFileSync(out, "utf8"));
      expect(result.status).toBe("dry-run");
      expect(result.groups.map((g: { groupUrlname: string }) => g.groupUrlname)).toEqual([
        "cpp-serbia",
        "CPPTORONTO",
      ]);
      expect(readFileSync(eventFile, "utf8")).toBe(EVENT_MARKDOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the single-group --output shape without --groups", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const eventFile = join(dir, "2026-05-09-test.md");
      const out = join(dir, "result.json");
      writeFileSync(config, NETWORK_CONFIG);
      writeFileSync(eventFile, EVENT_MARKDOWN);

      const { code } = await run([
        "create",
        "--config",
        config,
        "--dry-run",
        "--output",
        out,
        eventFile,
      ]);

      expect(code).toBe(0);
      const result = JSON.parse(readFileSync(out, "utf8"));
      expect(result).toEqual({ status: "dry-run" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 and reports partial when a group fails", async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const eventFile = join(dir, "2026-05-09-test.md");
      const out = join(dir, "result.json");
      // No "online" venue: every group fails to build its payload.
      writeFileSync(
        config,
        JSON.stringify({
          meetup: { groupUrlname: "cpp-serbia", venues: { other: 1 }, groups: ["CPPTORONTO"] },
        })
      );
      writeFileSync(eventFile, EVENT_MARKDOWN);

      const { code } = await run([
        "create",
        "--config",
        config,
        "--groups",
        "all",
        "--dry-run",
        "--output",
        out,
        eventFile,
      ]);

      expect(code).toBe(1);
      const result = JSON.parse(readFileSync(out, "utf8"));
      expect(result.status).toBe("partial");
      expect(result.groups.every((g: { ok: boolean }) => !g.ok)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats --groups "," as no --groups at all, not as every group', async () => {
    const dir = scratch();
    try {
      const config = join(dir, "coopkit.config.json");
      const eventFile = join(dir, "2026-05-09-test.md");
      const out = join(dir, "result.json");
      writeFileSync(config, NETWORK_CONFIG);
      writeFileSync(eventFile, EVENT_MARKDOWN);

      const { code } = await run([
        "create",
        "--config",
        config,
        "--groups",
        ",",
        "--dry-run",
        "--output",
        out,
        eventFile,
      ]);

      expect(code).toBe(0);
      // An empty parsed list used to be truthy, which silently meant "all".
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ status: "dry-run" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
