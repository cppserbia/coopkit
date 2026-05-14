import type { EventFrontmatter } from "./frontmatter.js";
import type { NormalizedEvent } from "./normalized-event.js";

/**
 * Convert a parsed event-markdown frontmatter + body into a
 * `NormalizedEvent`. The intended use is by file-source adopters
 * (cppserbia-style: one markdown file per event) so they can feed the
 * same automation packages as adopters with different source-of-truth.
 *
 * Pure function — does not touch the filesystem. The adopter is
 * responsible for reading the file and supplying the `id` (typically the
 * filename slug minus the extension).
 *
 * The leading H1 is NOT stripped here; that's a Meetup-specific transform
 * applied by `@coopkit/meetup` only.
 */
export function frontmatterToNormalizedEvent(
  id: string,
  fm: EventFrontmatter,
  body: string
): NormalizedEvent {
  const normalized: NormalizedEvent = {
    id,
    date: fm.date,
    title: fm.title,
    description: body,
    raw: { frontmatter: fm, body },
  };
  if (fm.duration !== undefined) normalized.duration = fm.duration;
  if (fm.venues && fm.venues.length > 0 && fm.venues[0] !== undefined) {
    normalized.venueKey = fm.venues[0];
  }
  if (fm.imageUrl !== undefined) normalized.imageUrl = fm.imageUrl;
  if (fm.youtube !== undefined) normalized.recordingUrl = fm.youtube;
  if (fm.registration_url !== undefined) normalized.registrationUrl = fm.registration_url;
  return normalized;
}
