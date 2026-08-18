import { describe, expect, it } from "bun:test";
import type { NormalizedEvent } from "@coopkit/core";
import { createMeetupDrafts } from "./create-event.js";

const EVENT: NormalizedEvent = {
  id: "2026-08-22-andy-soffer",
  title: "(GlobalCpp) Refactoring C++ Today",
  date: new Date("2026-08-22T16:00:00Z"),
  duration: "PT1H",
  venueKey: "online",
  description: "A pragmatic survey.",
};

const VENUES = { online: "online" } as const;

let calls = 0;

// dryRun keeps this offline: createMeetupDraft returns the built payload
// without touching the network.
async function dryRunAcross(groups: Array<{ urlname: string; hosts?: number[] }>) {
  return createMeetupDrafts({
    event: EVENT,
    groups,
    venues: { ...VENUES },
    timezone: "America/Chicago",
    dryRun: true,
    log: () => {},
  });
}

describe("createMeetupDrafts", () => {
  it("creates one draft per group, in order", async () => {
    const { results } = await dryRunAcross([
      { urlname: "chicago-c-cpp-users-group", hosts: [13296813] },
      { urlname: "cpp-serbia", hosts: [256192100] },
      { urlname: "CPPTORONTO", hosts: [274644230] },
    ]);

    expect(results.map((r) => r.groupUrlname)).toEqual([
      "chicago-c-cpp-users-group",
      "cpp-serbia",
      "CPPTORONTO",
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("gives each group its own groupUrlname and hosts in the payload", async () => {
    const { results } = await dryRunAcross([
      { urlname: "chicago-c-cpp-users-group", hosts: [13296813] },
      { urlname: "cpp-serbia", hosts: [256192100] },
    ]);

    const payloads = results.map((r) =>
      r.ok && r.result.status === "dry-run" ? r.result.payload : undefined
    );
    expect(payloads[0]?.groupUrlname).toBe("chicago-c-cpp-users-group");
    expect(payloads[0]?.eventHosts).toEqual([13296813]);
    expect(payloads[1]?.groupUrlname).toBe("cpp-serbia");
    expect(payloads[1]?.eventHosts).toEqual([256192100]);
  });

  it("applies the shared timezone to every group", async () => {
    const { results } = await dryRunAcross([
      { urlname: "chicago-c-cpp-users-group" },
      { urlname: "cpp-serbia" },
    ]);
    for (const r of results) {
      const payload = r.ok && r.result.status === "dry-run" ? r.result.payload : undefined;
      expect(payload?.startDateTime).toBe("2026-08-22T11:00:00");
    }
  });

  it("omits eventHosts for a group with no hosts", async () => {
    const { results } = await dryRunAcross([{ urlname: "solo-group" }]);
    const payload =
      results[0]?.ok && results[0].result.status === "dry-run"
        ? results[0].result.payload
        : undefined;
    expect(payload && "eventHosts" in payload).toBe(false);
  });

  it("reports a per-group failure without aborting the rest", async () => {
    calls = 0;
    // An unknown venue key fails inside the loop for that group only.
    const { results } = await createMeetupDrafts({
      event: EVENT,
      groups: [
        { urlname: "good-group" },
        { urlname: "bad-group" },
        { urlname: "another-good-group" },
      ],
      // A Proxy venue map that only misses the lookup for one group would need
      // per-group venues, which the API does not have; instead drive the failure
      // from the event by making the second call throw via a getter.
      venues: new Proxy(
        { ...VENUES },
        {
          has(target, key) {
            calls += 1;
            if (calls === 2) return false; // second group: venue "not found"
            return key in target;
          },
        }
      ) as Record<string, "online">,
      timezone: "America/Chicago",
      dryRun: true,
      log: () => {},
    });

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    const failure = results[1];
    expect(failure?.ok === false && failure.error).toMatch(/Unknown venue/);
  });

  it("throws when given no groups at all", async () => {
    await expect(
      createMeetupDrafts({
        event: EVENT,
        groups: [],
        venues: { ...VENUES },
        dryRun: true,
        log: () => {},
      })
    ).rejects.toThrow(/no groups/);
  });
});

describe("multi-group --output status", () => {
  // Mirrors cli.ts's aggregateStatus contract: a dry run must never be
  // reported as "created".
  it("reports dry-run runs as dry-run, not created", async () => {
    const { results } = await dryRunAcross([
      { urlname: "chicago-c-cpp-users-group" },
      { urlname: "cpp-serbia" },
    ]);
    const statuses = new Set(results.map((r) => (r.ok ? r.result.status : "failed")));
    expect([...statuses]).toEqual(["dry-run"]);
  });
});

describe("per-group timezone produces one instant everywhere", () => {
  it("renders 16:00Z as each group's own local wall time", async () => {
    const { results } = await createMeetupDrafts({
      event: EVENT, // 2026-08-22T16:00:00Z
      groups: [
        { urlname: "chicago-c-cpp-users-group", timezone: "America/Chicago" },
        { urlname: "cpp-serbia", timezone: "Europe/Belgrade" },
        { urlname: "CPPTORONTO", timezone: "America/Toronto" },
      ],
      venues: { ...VENUES },
      dryRun: true,
      log: () => {},
    });

    const starts = results.map((r) =>
      r.ok && r.result.status === "dry-run" ? r.result.payload.startDateTime : undefined
    );
    // Same instant, three wall clocks: CDT -5, CEST +2, EDT -4.
    expect(starts).toEqual(["2026-08-22T11:00:00", "2026-08-22T18:00:00", "2026-08-22T12:00:00"]);
  });

  it("falls back to the shared timezone for a group that names none", async () => {
    const { results } = await createMeetupDrafts({
      event: EVENT,
      groups: [{ urlname: "solo-group" }],
      venues: { ...VENUES },
      timezone: "America/Chicago",
      dryRun: true,
      log: () => {},
    });
    const payload =
      results[0]?.ok && results[0].result.status === "dry-run"
        ? results[0].result.payload
        : undefined;
    expect(payload?.startDateTime).toBe("2026-08-22T11:00:00");
  });
});
