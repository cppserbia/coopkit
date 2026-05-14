/**
 * Event frontmatter shape — the YAML at the top of an event markdown file.
 *
 * This is one of two ways adopters describe events to coopkit. The other is
 * `NormalizedEvent`. Adopters whose source-of-truth is one markdown file per
 * event (e.g. `events/YYYY-MM-DD-slug.md`) use this shape directly. Adopters
 * with a different source (a bullet list in README, a YAML data file, a CMS)
 * produce `NormalizedEvent` objects via their own extractor.
 *
 * Adopter repos are free to add fields beyond this contract — coopkit packages
 * only consume what they need.
 */
export interface EventFrontmatter {
  /** Event title. */
  title: string;

  /** Event start (gray-matter parses YAML date scalars as `Date`). */
  date: Date;

  /** ISO-8601 duration string (e.g. "PT2H"). Consumed by @coopkit/meetup. */
  duration?: string;

  /**
   * Venue keys. The first entry is the primary venue. Each adopter maps these
   * keys to platform-specific venue IDs via their own venue map.
   */
  venues?: string[];

  /** Public URL of the event banner image. Set by banner generation; read by Meetup. */
  imageUrl?: string;

  /** YouTube watch URL of the recording. Set after the event. */
  youtube?: string;

  /** Free-form description override. Optional; body text is preferred. */
  description?: string;

  /** Event format. */
  event_type?: "PHYSICAL" | "ONLINE" | "HYBRID";

  /** Lifecycle status. DRAFT = hidden in production. */
  status?: "DRAFT" | "ACTIVE" | "PAST";

  /** URL of the Meetup.com event (written back by @coopkit/meetup). */
  event_url?: string;

  /** Numeric Meetup event ID, or a placeholder before creation. */
  event_id?: string | number;

  /** Public registration URL (used by social media announcements). */
  registration_url?: string;
}
