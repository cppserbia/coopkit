// CLI-level tests that spawn the real bin. Dry-run only (no creds, no network):
// verifies arg parsing, config loading, and the --output result file used by
// the GitHub Action to surface event-id / event-url.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "coopkit-cli-"));
}

const CONFIG = JSON.stringify({
  meetup: { groupUrlname: "cpp-serbia", venues: { online: 42 } },
});

const EVENT = JSON.stringify({
  id: "2026-05-09-test",
  title: "Test Event",
  date: "2026-05-09T16:00:00Z",
  duration: "PT1H",
  venueKey: "online",
  description: "Body.",
});

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

const FAKE_MEETUP = join(import.meta.dir, "testing", "fake-meetup-preload.ts");

/**
 * Run the bin for real, not as a dry run, against the fake Meetup preloaded
 * into the child process (testing/fake-meetup.ts): no network, no secrets.
 */
async function runAgainstFakeMeetup(args: string[], cwd: string): Promise<{ code: number }> {
  const proc = Bun.spawn(["bun", "--preload", FAKE_MEETUP, CLI, ...args], {
    cwd,
    env: { ...process.env, COOPKIT_FAKE_MEETUP: "{}" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return { code };
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

// A multi-group config. Each group needs its own timezone, or resolveGroupTargets
// refuses the run -- see "per-group timezones" in config.test.ts.
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
          meetup: { groupUrlname: "cpp-serbia", venues: { online: 42 }, speakerDetails: true },
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
