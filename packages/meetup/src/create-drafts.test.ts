import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEvent } from "@coopkit/core";
import type { MeetupCredentials } from "./client.js";
import { createMeetupDrafts } from "./create-event.js";
import type { CreateEventPayload } from "./payload.js";

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
// without touching the network. No shared `timezone`: with several groups that
// would need a per-group lookup, which a dry run refuses (see below).
async function dryRunAcross(groups: Array<{ urlname: string; hosts?: number[] }>) {
  return createMeetupDrafts({
    event: EVENT,
    groups,
    venues: { ...VENUES },
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

  it("uses the legacy wall-time reading for every group when no timezone is given", async () => {
    const { results } = await dryRunAcross([
      { urlname: "chicago-c-cpp-users-group" },
      { urlname: "cpp-serbia" },
    ]);
    for (const r of results) {
      const payload = r.ok && r.result.status === "dry-run" ? r.result.payload : undefined;
      expect(payload?.startDateTime).toBe("2026-08-22T16:00:00");
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

// Non-dry runs against a stubbed `fetch`: the real client signs a JWT with a
// throwaway key, then every request is answered here, so nothing reaches Meetup.
describe("timezone lookup for a multi-group run with a shared timezone", () => {
  type Answer = string | null | Error;
  type Call =
    | { kind: "token" }
    | { kind: "group"; urlname: string }
    | { kind: "create"; input: CreateEventPayload };

  const realFetch = globalThis.fetch;
  let keyDir = "";
  let credentials: MeetupCredentials;

  beforeAll(() => {
    keyDir = mkdtempSync(join(tmpdir(), "coopkit-key-"));
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const privateKeyPath = join(keyDir, "key.pem");
    writeFileSync(privateKeyPath, privateKey);
    credentials = { clientKey: "test", memberId: "1", privateKeyPath, signingKeyId: "kid" };
  });

  afterAll(() => {
    rmSync(keyDir, { recursive: true, force: true });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /**
   * Answer group lookups from `timezones` (by urlname) and accept every
   * createEvent. `rejectToken` makes the OAuth exchange fail instead.
   */
  function stubMeetup(timezones: Record<string, Answer>, rejectToken = false): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("oauth2")) {
        calls.push({ kind: "token" });
        if (rejectToken) return new Response("invalid_grant", { status: 401 });
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("createEvent")) {
        calls.push({ kind: "create", input: variables.input });
        const id = String(calls.filter((c) => c.kind === "create").length);
        return Response.json({
          data: { createEvent: { event: { id, eventUrl: `https://m.test/${id}` }, errors: null } },
        });
      }
      if (query.includes("timezone")) {
        const urlname: string = variables.urlname;
        calls.push({ kind: "group", urlname });
        const answer = timezones[urlname];
        if (answer instanceof Error) {
          return Response.json({ errors: [{ message: answer.message }] });
        }
        if (answer === undefined) return Response.json({ data: { groupByUrlname: null } });
        return Response.json({
          data: { groupByUrlname: { urlname, name: urlname, timezone: answer } },
        });
      }
      throw new Error(`Unexpected request in test: ${query}`);
    }) as typeof fetch;
    return calls;
  }

  const MEETUP_ZONES = {
    "chicago-c-cpp-users-group": "America/Chicago",
    "cpp-serbia": "Europe/Belgrade",
    CPPTORONTO: "America/Toronto",
  };

  function createdStarts(calls: Call[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of calls) {
      if (c.kind === "create") out[c.input.groupUrlname] = c.input.startDateTime;
    }
    return out;
  }

  it("looks up each unmapped group and creates the same instant in every group", async () => {
    const calls = stubMeetup(MEETUP_ZONES);
    const logs: string[] = [];
    const { results } = await createMeetupDrafts({
      event: EVENT, // 2026-08-22T16:00:00Z
      groups: [
        { urlname: "chicago-c-cpp-users-group" },
        { urlname: "cpp-serbia" },
        { urlname: "CPPTORONTO" },
      ],
      venues: { ...VENUES },
      timezone: "America/Chicago",
      credentials,
      log: (m) => logs.push(m),
    });

    expect(results.every((r) => r.ok && r.result.status === "created")).toBe(true);
    // Never the shared Chicago wall time for all three: CDT -5, CEST +2, EDT -4.
    expect(createdStarts(calls)).toEqual({
      "chicago-c-cpp-users-group": "2026-08-22T11:00:00",
      "cpp-serbia": "2026-08-22T18:00:00",
      CPPTORONTO: "2026-08-22T12:00:00",
    });
    // Every lookup happens before the first draft is created.
    const kinds = calls.filter((c) => c.kind !== "token").map((c) => c.kind);
    expect(kinds).toEqual(["group", "group", "group", "create", "create", "create"]);
    expect(logs).toContain(
      "[info] Using Meetup's timezone for cpp-serbia: Europe/Belgrade (pin it with meetup.groupTimezones)"
    );
    expect(logs.filter((m) => m.startsWith("[info] Using Meetup's timezone"))).toHaveLength(3);
  });

  it("does not look up groups that have their own timezone", async () => {
    const calls = stubMeetup(MEETUP_ZONES);
    await createMeetupDrafts({
      event: EVENT,
      groups: [
        { urlname: "chicago-c-cpp-users-group", timezone: "America/Chicago" },
        { urlname: "cpp-serbia" },
        // An explicit entry wins even where Meetup would say otherwise.
        { urlname: "CPPTORONTO", timezone: "America/Winnipeg" },
      ],
      venues: { ...VENUES },
      timezone: "America/Chicago",
      credentials,
      log: () => {},
    });

    const lookedUp = calls.flatMap((c) => (c.kind === "group" ? [c.urlname] : []));
    expect(lookedUp).toEqual(["cpp-serbia"]);
    expect(createdStarts(calls)).toEqual({
      "chicago-c-cpp-users-group": "2026-08-22T11:00:00",
      "cpp-serbia": "2026-08-22T18:00:00",
      CPPTORONTO: "2026-08-22T11:00:00",
    });
  });

  it("aborts before creating any draft when a lookup fails", async () => {
    const calls = stubMeetup({
      "chicago-c-cpp-users-group": "America/Chicago",
      "cpp-serbia": null, // Meetup answers, but with no timezone
      CPPTORONTO: new Error("Not authorized"),
    });

    const run = createMeetupDrafts({
      event: EVENT,
      groups: [
        { urlname: "chicago-c-cpp-users-group" },
        { urlname: "cpp-serbia" },
        { urlname: "CPPTORONTO" },
      ],
      venues: { ...VENUES },
      timezone: "America/Chicago",
      credentials,
      log: () => {},
    });

    await expect(run).rejects.toThrow(/No drafts were created/);
    await expect(run).rejects.toThrow(/"cpp-serbia" \(Meetup returned none\)/);
    await expect(run).rejects.toThrow(/"CPPTORONTO" \(Meetup GraphQL error: Not authorized\)/);
    await expect(run).rejects.toThrow(
      /Add meetup.groupTimezones entries for "cpp-serbia", "CPPTORONTO" \(run `coopkit-meetup list-groups`/
    );
    expect(calls.some((c) => c.kind === "create")).toBe(false);
  });

  it("names a cause shared by every group once", async () => {
    const calls = stubMeetup(MEETUP_ZONES, true);

    const run = createMeetupDrafts({
      event: EVENT,
      groups: [{ urlname: "cpp-serbia" }, { urlname: "CPPTORONTO" }],
      venues: { ...VENUES },
      timezone: "America/Chicago",
      credentials,
      log: () => {},
    });

    await expect(run).rejects.toThrow(
      /timezone of "cpp-serbia", "CPPTORONTO" \(OAuth2 token exchange failed: 401/
    );
    expect(calls.some((c) => c.kind === "create")).toBe(false);
  });

  it("refuses a dry run that would need a lookup, without any request", async () => {
    const calls = stubMeetup(MEETUP_ZONES);
    const logs: string[] = [];

    const run = createMeetupDrafts({
      event: EVENT,
      groups: [
        { urlname: "chicago-c-cpp-users-group", timezone: "America/Chicago" },
        { urlname: "cpp-serbia" },
        { urlname: "CPPTORONTO" },
      ],
      venues: { ...VENUES },
      timezone: "America/Chicago",
      dryRun: true,
      credentials,
      log: (m) => logs.push(m),
    });

    await expect(run).rejects.toThrow(
      /Dry run cannot look up the timezone of "cpp-serbia", "CPPTORONTO"/
    );
    await expect(run).rejects.toThrow(/meetup.groupTimezones .*or run without --dry-run/);
    expect(calls).toEqual([]);
    // Refused up front: no group was started.
    expect(logs.some((m) => m.startsWith("[1/"))).toBe(false);
  });

  it("dry-runs a fully mapped multi-group run as before, without any request", async () => {
    const calls = stubMeetup(MEETUP_ZONES);
    const { results } = await createMeetupDrafts({
      event: EVENT,
      groups: [
        { urlname: "chicago-c-cpp-users-group", timezone: "America/Chicago" },
        { urlname: "cpp-serbia", timezone: "Europe/Belgrade" },
      ],
      venues: { ...VENUES },
      timezone: "America/Chicago",
      dryRun: true,
      credentials,
      log: () => {},
    });

    expect(calls).toEqual([]);
    expect(
      results.map((r) =>
        r.ok && r.result.status === "dry-run" ? r.result.payload.startDateTime : undefined
      )
    ).toEqual(["2026-08-22T11:00:00", "2026-08-22T18:00:00"]);
  });

  it("keeps using the shared timezone for a single group, with no lookup", async () => {
    const calls = stubMeetup(MEETUP_ZONES);
    await createMeetupDrafts({
      event: EVENT,
      groups: [{ urlname: "cpp-serbia" }],
      venues: { ...VENUES },
      timezone: "America/Chicago",
      credentials,
      log: () => {},
    });

    expect(calls.some((c) => c.kind === "group")).toBe(false);
    expect(createdStarts(calls)).toEqual({ "cpp-serbia": "2026-08-22T11:00:00" });
  });
});
