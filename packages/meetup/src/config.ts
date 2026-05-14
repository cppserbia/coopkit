import fs from "node:fs";
import path from "node:path";
import type { VenueMap } from "./venues.js";

export interface MeetupConfig {
  groupUrlname: string;
  venues: VenueMap;
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
  return meetup;
}
