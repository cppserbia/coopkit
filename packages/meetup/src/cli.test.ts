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
