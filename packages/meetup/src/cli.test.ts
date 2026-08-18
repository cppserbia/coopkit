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

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
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
