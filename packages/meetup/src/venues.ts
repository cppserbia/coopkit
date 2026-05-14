/**
 * Map from event frontmatter `venues:` strings to numeric Meetup venue IDs.
 *
 * Keys MUST be the exact string in event frontmatter — including quotes,
 * diacritics, and any ", City, cc" suffix. Use `coopkit-meetup list-venues`
 * to discover the right keys for your group.
 */
export type VenueMap = Record<string, number>;

export function resolveVenueId(venueName: string, map: VenueMap): number {
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
  if (id === undefined || !Number.isFinite(id) || id <= 0) {
    throw new Error(
      `Venue ${JSON.stringify(venueName)} is registered in the venue map but has a ` +
        `placeholder ID (${id}). Replace it with the real Meetup venue ID.`
    );
  }
  return id;
}
