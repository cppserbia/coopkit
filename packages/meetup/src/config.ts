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
