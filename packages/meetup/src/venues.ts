/**
 * Map from event frontmatter `venues:` strings to Meetup venue IDs.
 *
 * Keys MUST be the exact string in event frontmatter — including quotes,
 * diacritics, and any ", City, cc" suffix. Use `coopkit-meetup list-venues`
 * to discover the right keys for your group.
 *
 * Values are numeric Meetup venue IDs, or the literal `"online"` for online
 * events. Meetup has no venue record for an online event: `list-venues` will
 * never return one, and `CreateEventInput.venueId` is a `String` that takes
 * the sentinel `"online"` instead of an ID.
 */
export type VenueId = number | "online";

export const ONLINE_VENUE_ID = "online" as const;

export type VenueMap = Record<string, VenueId>;

export function resolveVenueId(venueName: string, map: VenueMap): VenueId {
  if (!(venueName in map)) {
    const known = Object.keys(map);
    const keys =
      known.length === 0
        ? "  (none yet — populate the `meetup.venues` map in coopkit.config.json)"
        : known.map((k) => `  - ${JSON.stringify(k)}`).join("\n");
    throw new Error(
      `Unknown venue ${JSON.stringify(venueName)}. ` +
        `Add it to your venue map.\nKnown venues:\n${keys}`
    );
  }
  const id = map[venueName];
  if (id === ONLINE_VENUE_ID) return id;
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) {
    throw new Error(
      `Venue ${JSON.stringify(venueName)} is registered in the venue map but has a ` +
        `placeholder ID (${JSON.stringify(id)}). Replace it with the real Meetup venue ID, ` +
        `or ${JSON.stringify(ONLINE_VENUE_ID)} for an online event.`
    );
  }
  return id;
}
