import fs from "node:fs";
import path from "node:path";
import type { VenueMap } from "./venues.js";

export interface MeetupConfig {
  groupUrlname: string;
  venues: VenueMap;
  /**
   * IANA timezone of the group (e.g. "America/Chicago"). Set this when your
   * event dates are true UTC instants; see `BuildPayloadInput.timezone` for
   * why omitting it means "the date is already local wall time".
   */
  timezone?: string;
  /** Named Meetup member IDs, so config and CLI can refer to people by name. */
  hosts?: Record<string, number>;
  /** Names from `hosts` to list as event hosts when an event names none itself. */
  defaultHosts?: string[];
  /**
   * Additional group urlnames a single event should be created in, for a Meetup
   * Pro network whose groups cross-post the same session. `groupUrlname` is
   * always the first target; these follow, in order.
   */
  groups?: string[];
  /**
   * Per-group host overrides, keyed by group urlname, with values being names
   * from `hosts`. Each group in a network usually has its own organizer, so a
   * single `defaultHosts` rarely fits all of them.
   */
  groupHosts?: Record<string, string[]>;
  /**
   * Attach the event's speaker as Meetup's speaker profile. This is a **Pro**
   * feature and groups outside a Pro network reject it, so it is opt-in:
   * `true` for every group, or a list of the group urlnames that support it.
   */
  speakerDetails?: boolean | string[];
  /**
   * Per-group IANA timezone, keyed by group urlname.
   *
   * **Required when targeting more than one group**, because Meetup has no
   * single "event time": `startDateTime` is wall time in the *receiving group's*
   * own zone. Sending one group's wall time to all of them creates a different
   * instant in each — a session at 16:00Z becomes 11:00 in Chicago but also
   * 11:00 in Belgrade, seven hours apart. Run `coopkit-meetup list-groups` to
   * print a ready-to-paste map of what Meetup reports for each of your groups.
   */
  groupTimezones?: Record<string, string>;
}

export interface CoopkitConfig {
  meetup?: MeetupConfig;
  // Other subsystems (banners, social) plug in here in later phases.
}

export const DEFAULT_CONFIG_FILENAME = "coopkit.config.json";

/**
 * Load and validate `coopkit.config.json` from disk. Resolves relative paths
 * against the current working directory. Throws on missing or malformed
 * `meetup` block, since this package can't function without one.
 */
export function loadMeetupConfig(configPath?: string): MeetupConfig {
  const resolved = path.resolve(configPath ?? DEFAULT_CONFIG_FILENAME);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `coopkit config not found at ${resolved}. Create a coopkit.config.json with a \`meetup\` block, or pass --config <path>.`
    );
  }

  let parsed: CoopkitConfig;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as CoopkitConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${resolved}: ${msg}`);
  }

  const meetup = parsed.meetup;
  if (!meetup) {
    throw new Error(`${resolved} is missing a "meetup" block.`);
  }
  if (!meetup.groupUrlname || typeof meetup.groupUrlname !== "string") {
    throw new Error(`${resolved}: meetup.groupUrlname must be a non-empty string.`);
  }
  if (!meetup.venues || typeof meetup.venues !== "object") {
    throw new Error(`${resolved}: meetup.venues must be an object mapping venue names to IDs.`);
  }
  if (meetup.timezone !== undefined && typeof meetup.timezone !== "string") {
    throw new Error(`${resolved}: meetup.timezone must be an IANA timezone string.`);
  }
  if (meetup.hosts !== undefined) {
    if (typeof meetup.hosts !== "object" || meetup.hosts === null) {
      throw new Error(`${resolved}: meetup.hosts must be an object mapping names to member IDs.`);
    }
    for (const [name, id] of Object.entries(meetup.hosts)) {
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
        throw new Error(
          `${resolved}: meetup.hosts[${JSON.stringify(name)}] must be a positive integer Meetup member ID (got ${JSON.stringify(id)}).`
        );
      }
    }
  }
  if (meetup.groups !== undefined) {
    if (
      !Array.isArray(meetup.groups) ||
      meetup.groups.some((g) => typeof g !== "string" || g === "")
    ) {
      throw new Error(`${resolved}: meetup.groups must be an array of non-empty group urlnames.`);
    }
  }
  if (meetup.groupHosts !== undefined) {
    if (typeof meetup.groupHosts !== "object" || meetup.groupHosts === null) {
      throw new Error(
        `${resolved}: meetup.groupHosts must be an object mapping group urlnames to host-name arrays.`
      );
    }
    for (const [group, names] of Object.entries(meetup.groupHosts)) {
      if (!Array.isArray(names)) {
        throw new Error(
          `${resolved}: meetup.groupHosts[${JSON.stringify(group)}] must be an array.`
        );
      }
      for (const name of names) {
        if (typeof name !== "string" || !meetup.hosts || !(name in meetup.hosts)) {
          throw new Error(
            `${resolved}: meetup.groupHosts[${JSON.stringify(group)}] entry ${JSON.stringify(name)} is not a key of meetup.hosts.`
          );
        }
      }
    }
  }
  if (meetup.speakerDetails !== undefined) {
    const sd = meetup.speakerDetails;
    const ok =
      typeof sd === "boolean" ||
      (Array.isArray(sd) && sd.every((g) => typeof g === "string" && g !== ""));
    if (!ok) {
      throw new Error(
        `${resolved}: meetup.speakerDetails must be true/false or an array of group urlnames.`
      );
    }
  }
  if (meetup.groupTimezones !== undefined) {
    const tzs = meetup.groupTimezones;
    if (typeof tzs !== "object" || tzs === null || Array.isArray(tzs)) {
      throw new Error(
        `${resolved}: meetup.groupTimezones must be an object mapping group urlnames to IANA timezones.`
      );
    }
    for (const [group, tz] of Object.entries(tzs)) {
      if (typeof tz !== "string" || tz === "") {
        throw new Error(
          `${resolved}: meetup.groupTimezones[${JSON.stringify(group)}] must be a non-empty IANA timezone string.`
        );
      }
    }
  }
  if (meetup.defaultHosts !== undefined) {
    if (!Array.isArray(meetup.defaultHosts)) {
      throw new Error(
        `${resolved}: meetup.defaultHosts must be an array of names from meetup.hosts.`
      );
    }
    // Fail here rather than at call time: a typo'd name would otherwise
    // silently create the event with no host at all.
    for (const name of meetup.defaultHosts) {
      if (typeof name !== "string" || !meetup.hosts || !(name in meetup.hosts)) {
        throw new Error(
          `${resolved}: meetup.defaultHosts entry ${JSON.stringify(name)} is not a key of meetup.hosts.`
        );
      }
    }
  }
  return meetup;
}

/**
 * Resolve host names to Meetup member IDs, falling back to `defaultHosts`.
 * Returns [] when neither is configured, which leaves `eventHosts` off the
 * payload entirely (Meetup then defaults to the creating organizer).
 */
export function resolveHostIds(config: MeetupConfig, names?: string[]): number[] {
  const wanted = names && names.length > 0 ? names : (config.defaultHosts ?? []);
  return wanted.map((name) => {
    const id = config.hosts?.[name];
    if (id === undefined) {
      const known = Object.keys(config.hosts ?? {});
      const suffix =
        known.length > 0 ? ` Known hosts: ${known.map((k) => JSON.stringify(k)).join(", ")}.` : "";
      throw new Error(`Unknown host ${JSON.stringify(name)}. Add it to meetup.hosts.${suffix}`);
    }
    return id;
  });
}

/** One group an event should be created in, with its hosts already resolved. */
export interface GroupTarget {
  urlname: string;
  hosts: number[];
  /** Whether this group accepts Meetup's Pro speaker profile. */
  includeSpeaker: boolean;
  /**
   * IANA timezone this group's wall time is expressed in. Undefined means the
   * event date is already group-local wall time (the legacy reading).
   */
  timezone?: string;
}

/** Does this group opt into speakerDetails? See `MeetupConfig.speakerDetails`. */
export function groupAcceptsSpeaker(config: MeetupConfig, urlname: string): boolean {
  const sd = config.speakerDetails;
  if (sd === undefined || sd === false) return false;
  if (sd === true) return true;
  return sd.some((g) => g.toLowerCase() === urlname.toLowerCase());
}

/**
 * Expand config into the ordered list of groups to create the event in.
 *
 * `groupUrlname` is always first, then `groups`, de-duplicated
 * case-insensitively (Meetup urlnames are case-insensitive, and a network can
 * report a group as "CPPTORONTO" while a config says "cpptoronto"). Hosts come
 * from `groupHosts[urlname]` when present, else the `hostNames` override, else
 * `defaultHosts`.
 */
export function resolveGroupTargets(
  config: MeetupConfig,
  options: { only?: string[]; hostNames?: string[] } = {}
): GroupTarget[] {
  const all = [config.groupUrlname, ...(config.groups ?? [])];

  const seen = new Set<string>();
  const ordered = all.filter((urlname) => {
    const key = urlname.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let selected = ordered;
  if (options.only && options.only.length > 0) {
    const wanted = new Set(options.only.map((g) => g.toLowerCase()));
    selected = ordered.filter((urlname) => wanted.has(urlname.toLowerCase()));
    const missing = options.only.filter(
      (g) => !ordered.some((u) => u.toLowerCase() === g.toLowerCase())
    );
    if (missing.length > 0) {
      throw new Error(
        `Group(s) ${missing.map((g) => JSON.stringify(g)).join(", ")} are not in this config. ` +
          `Known: ${ordered.map((g) => JSON.stringify(g)).join(", ")}.`
      );
    }
  }

  // Match groupHosts keys case-insensitively too, for the same reason.
  const hostsByGroup = new Map(
    Object.entries(config.groupHosts ?? {}).map(([g, names]) => [g.toLowerCase(), names])
  );

  const tzByGroup = new Map(
    Object.entries(config.groupTimezones ?? {}).map(([g, tz]) => [g.toLowerCase(), tz])
  );

  // One `timezone` shared across several groups is never right: Meetup reads
  // startDateTime in the *receiving* group's zone, so the same wall time is a
  // different instant per group. Refuse rather than silently placing it at the wrong time.
  if (selected.length > 1 && config.timezone !== undefined) {
    const unmapped = selected.filter((u) => !tzByGroup.has(u.toLowerCase()));
    if (unmapped.length > 0) {
      const missing = unmapped.map((u) => JSON.stringify(u)).join(", ");
      throw new Error(
        [
          "meetup.timezone alone cannot describe a multi-group run: Meetup interprets",
          "the event time in each group's own timezone, so one wall time would land at",
          `a different instant in each. Add meetup.groupTimezones entries for ${missing}`,
          "(run `coopkit-meetup list-groups` to print them).",
        ].join(" ")
      );
    }
  }

  return selected.map((urlname) => {
    const perGroup = hostsByGroup.get(urlname.toLowerCase());
    const names = perGroup ?? options.hostNames;
    const timezone = tzByGroup.get(urlname.toLowerCase()) ?? config.timezone;
    return {
      urlname,
      hosts: resolveHostIds(config, names),
      includeSpeaker: groupAcceptsSpeaker(config, urlname),
      ...(timezone !== undefined ? { timezone } : {}),
    };
  });
}
