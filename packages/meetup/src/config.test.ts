import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type MeetupConfig, loadMeetupConfig, resolveHostIds } from "./config.js";

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
