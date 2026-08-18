import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type MeetupConfig,
  groupAcceptsSpeaker,
  loadMeetupConfig,
  resolveGroupTargets,
  resolveHostIds,
} from "./config.js";

function writeConfig(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coopkit-config-"));
  const file = path.join(dir, "coopkit.config.json");
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

const BASE = {
  groupUrlname: "chicago-c-cpp-users-group",
  venues: { online: "online" },
};

describe("loadMeetupConfig hosts/timezone", () => {
  it("accepts a config with neither hosts nor timezone", () => {
    const cfg = loadMeetupConfig(writeConfig({ meetup: BASE }));
    expect(cfg.timezone).toBeUndefined();
    expect(cfg.hosts).toBeUndefined();
  });

  it("loads timezone and hosts", () => {
    const cfg = loadMeetupConfig(
      writeConfig({
        meetup: { ...BASE, timezone: "America/Chicago", hosts: { "Rob Douglas": 13296813 } },
      })
    );
    expect(cfg.timezone).toBe("America/Chicago");
    expect(cfg.hosts).toEqual({ "Rob Douglas": 13296813 });
  });

  it("rejects a non-string timezone", () => {
    expect(() => loadMeetupConfig(writeConfig({ meetup: { ...BASE, timezone: 5 } }))).toThrow(
      /meetup.timezone must be an IANA timezone string/
    );
  });

  it("rejects a non-integer member ID", () => {
    expect(() =>
      loadMeetupConfig(writeConfig({ meetup: { ...BASE, hosts: { Rob: "13296813" } } }))
    ).toThrow(/positive integer Meetup member ID/);
  });

  it("rejects a defaultHosts name that is not in hosts", () => {
    expect(() =>
      loadMeetupConfig(
        writeConfig({ meetup: { ...BASE, hosts: { Rob: 13296813 }, defaultHosts: ["Bob"] } })
      )
    ).toThrow(/defaultHosts entry "Bob" is not a key of meetup.hosts/);
  });

  it("rejects defaultHosts when hosts is absent entirely", () => {
    expect(() =>
      loadMeetupConfig(writeConfig({ meetup: { ...BASE, defaultHosts: ["Rob"] } }))
    ).toThrow(/is not a key of meetup.hosts/);
  });
});

describe("resolveHostIds", () => {
  const cfg: MeetupConfig = {
    ...BASE,
    venues: { online: "online" },
    hosts: { "Rob Douglas": 13296813, "Alex Smith": 256192100 },
    defaultHosts: ["Rob Douglas"],
  };

  it("falls back to defaultHosts when no names are given", () => {
    expect(resolveHostIds(cfg)).toEqual([13296813]);
  });

  it("falls back to defaultHosts for an empty name list", () => {
    expect(resolveHostIds(cfg, [])).toEqual([13296813]);
  });

  it("resolves explicit names in order, overriding the default", () => {
    expect(resolveHostIds(cfg, ["Alex Smith", "Rob Douglas"])).toEqual([256192100, 13296813]);
  });

  it("returns [] when neither names nor defaultHosts exist", () => {
    expect(resolveHostIds({ ...BASE, venues: { online: "online" } })).toEqual([]);
  });

  it("throws on an unknown name and lists the known ones", () => {
    expect(() => resolveHostIds(cfg, ["Nobody"])).toThrow(/Unknown host "Nobody"/);
    expect(() => resolveHostIds(cfg, ["Nobody"])).toThrow(/Known hosts: "Rob Douglas"/);
  });
});

describe("loadMeetupConfig groups/groupHosts", () => {
  it("loads groups and groupHosts", () => {
    const cfg = loadMeetupConfig(
      writeConfig({
        meetup: {
          ...BASE,
          hosts: { "Rob Douglas": 13296813 },
          groups: ["cpp-serbia"],
          groupHosts: { "chicago-c-cpp-users-group": ["Rob Douglas"] },
        },
      })
    );
    expect(cfg.groups).toEqual(["cpp-serbia"]);
    expect(cfg.groupHosts).toEqual({ "chicago-c-cpp-users-group": ["Rob Douglas"] });
  });

  it("rejects a non-array groups", () => {
    expect(() => loadMeetupConfig(writeConfig({ meetup: { ...BASE, groups: "a" } }))).toThrow(
      /meetup.groups must be an array/
    );
  });

  it("rejects a groupHosts name that is not in hosts", () => {
    expect(() =>
      loadMeetupConfig(
        writeConfig({
          meetup: { ...BASE, hosts: { Rob: 1 }, groupHosts: { "some-group": ["Nope"] } },
        })
      )
    ).toThrow(/groupHosts\["some-group"\] entry "Nope" is not a key of meetup.hosts/);
  });
});

describe("resolveGroupTargets", () => {
  const cfg: MeetupConfig = {
    groupUrlname: "chicago-c-cpp-users-group",
    venues: { online: "online" },
    hosts: { "Rob Douglas": 13296813, "Alex Smith": 256192100, "Jordan Lee": 274644230 },
    defaultHosts: ["Rob Douglas"],
    groups: ["cpp-serbia", "CPPTORONTO"],
    groupHosts: {
      "chicago-c-cpp-users-group": ["Rob Douglas"],
      "cpp-serbia": ["Alex Smith"],
      cpptoronto: ["Jordan Lee"],
    },
  };

  it("puts groupUrlname first, then groups in order", () => {
    expect(resolveGroupTargets(cfg).map((t) => t.urlname)).toEqual([
      "chicago-c-cpp-users-group",
      "cpp-serbia",
      "CPPTORONTO",
    ]);
  });

  it("resolves per-group hosts, matching keys case-insensitively", () => {
    const targets = resolveGroupTargets(cfg);
    expect(targets.map((t) => t.hosts)).toEqual([[13296813], [256192100], [274644230]]);
  });

  it("falls back to defaultHosts for a group with no override", () => {
    const targets = resolveGroupTargets({ ...cfg, groupHosts: {} });
    expect(targets.every((t) => t.hosts[0] === 13296813)).toBe(true);
  });

  it("de-duplicates groupUrlname repeated in groups, case-insensitively", () => {
    const targets = resolveGroupTargets({
      ...cfg,
      groups: ["CHICAGO-C-CPP-USERS-GROUP", "cpp-serbia"],
    });
    expect(targets.map((t) => t.urlname)).toEqual(["chicago-c-cpp-users-group", "cpp-serbia"]);
  });

  it("narrows to the requested groups", () => {
    expect(resolveGroupTargets(cfg, { only: ["cpp-serbia"] }).map((t) => t.urlname)).toEqual([
      "cpp-serbia",
    ]);
  });

  it("matches the `only` filter case-insensitively", () => {
    expect(resolveGroupTargets(cfg, { only: ["cpptoronto"] }).map((t) => t.urlname)).toEqual([
      "CPPTORONTO",
    ]);
  });

  it("throws when a requested group is not in the config", () => {
    expect(() => resolveGroupTargets(cfg, { only: ["winnipeg-cpp"] })).toThrow(
      /"winnipeg-cpp" are not in this config/
    );
  });

  it("returns just the one group when no groups list is configured", () => {
    const targets = resolveGroupTargets({
      groupUrlname: "solo-group",
      venues: { online: "online" },
    });
    expect(targets).toEqual([{ urlname: "solo-group", hosts: [], includeSpeaker: false }]);
  });

  it("lets an explicit hostNames override apply to groups without a groupHosts entry", () => {
    const targets = resolveGroupTargets({ ...cfg, groupHosts: {} }, { hostNames: ["Alex Smith"] });
    expect(targets.every((t) => t.hosts[0] === 256192100)).toBe(true);
  });
});

describe("speakerDetails gating", () => {
  const base: MeetupConfig = { groupUrlname: "a-group", venues: { online: "online" } };

  it("is off when unset", () => {
    expect(groupAcceptsSpeaker(base, "a-group")).toBe(false);
  });

  it("is off when explicitly false", () => {
    expect(groupAcceptsSpeaker({ ...base, speakerDetails: false }, "a-group")).toBe(false);
  });

  it("is on for every group when true", () => {
    const cfg = { ...base, speakerDetails: true };
    expect(groupAcceptsSpeaker(cfg, "a-group")).toBe(true);
    expect(groupAcceptsSpeaker(cfg, "anything-else")).toBe(true);
  });

  it("is on only for listed groups, case-insensitively", () => {
    const cfg = { ...base, speakerDetails: ["CPPTORONTO"] };
    expect(groupAcceptsSpeaker(cfg, "cpptoronto")).toBe(true);
    expect(groupAcceptsSpeaker(cfg, "cpp-serbia")).toBe(false);
  });

  it("flows onto resolved group targets", () => {
    const targets = resolveGroupTargets({
      ...base,
      groups: ["b-group"],
      speakerDetails: ["b-group"],
    });
    expect(targets.map((t) => [t.urlname, t.includeSpeaker])).toEqual([
      ["a-group", false],
      ["b-group", true],
    ]);
  });

  it("rejects a malformed speakerDetails value", () => {
    expect(() =>
      loadMeetupConfig(writeConfig({ meetup: { ...BASE, speakerDetails: 42 } }))
    ).toThrow(/speakerDetails must be true\/false or an array of group urlnames/);
  });
});

describe("per-group timezones", () => {
  const NETWORK: MeetupConfig = {
    groupUrlname: "chicago-c-cpp-users-group",
    venues: { online: "online" },
    groups: ["cpp-serbia", "CPPTORONTO"],
    groupTimezones: {
      "chicago-c-cpp-users-group": "America/Chicago",
      "cpp-serbia": "Europe/Belgrade",
      CPPTORONTO: "America/Toronto",
    },
  };

  it("gives every group its own timezone", () => {
    expect(resolveGroupTargets(NETWORK).map((t) => [t.urlname, t.timezone])).toEqual([
      ["chicago-c-cpp-users-group", "America/Chicago"],
      ["cpp-serbia", "Europe/Belgrade"],
      ["CPPTORONTO", "America/Toronto"],
    ]);
  });

  it("matches groupTimezones keys case-insensitively", () => {
    const targets = resolveGroupTargets({
      ...NETWORK,
      groups: ["cpptoronto"],
      groupTimezones: {
        "chicago-c-cpp-users-group": "America/Chicago",
        CPPTORONTO: "America/Toronto",
      },
    });
    expect(targets.find((t) => t.urlname === "cpptoronto")?.timezone).toBe("America/Toronto");
  });

  it("refuses a multi-group run that has only one shared timezone", () => {
    // The bug this guards: one wall time sent to groups in different zones is a
    // different instant in each.
    expect(() =>
      resolveGroupTargets({
        groupUrlname: "chicago-c-cpp-users-group",
        venues: { online: "online" },
        groups: ["cpp-serbia"],
        timezone: "America/Chicago",
      })
    ).toThrow(/cannot describe a multi-group run/);
  });

  it("names the groups missing a timezone", () => {
    expect(() =>
      resolveGroupTargets({
        ...NETWORK,
        timezone: "America/Chicago",
        groupTimezones: { "chicago-c-cpp-users-group": "America/Chicago" },
      })
    ).toThrow(/"cpp-serbia", "CPPTORONTO"/);
  });

  it("allows a single-group run with only the shared timezone", () => {
    const targets = resolveGroupTargets({
      groupUrlname: "solo-group",
      venues: { online: "online" },
      timezone: "America/Chicago",
    });
    expect(targets[0]?.timezone).toBe("America/Chicago");
  });

  it("allows a narrowed single-group run even when the config is multi-group", () => {
    const targets = resolveGroupTargets(
      { ...NETWORK, groupTimezones: undefined, timezone: "Europe/Belgrade" },
      { only: ["cpp-serbia"] }
    );
    expect(targets.map((t) => [t.urlname, t.timezone])).toEqual([
      ["cpp-serbia", "Europe/Belgrade"],
    ]);
  });

  it("rejects a malformed groupTimezones value", () => {
    expect(() =>
      loadMeetupConfig(writeConfig({ meetup: { ...BASE, groupTimezones: { "a-group": 5 } } }))
    ).toThrow(/must be a non-empty IANA timezone string/);
  });
});
