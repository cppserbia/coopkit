/**
 * Platform-neutral event description that automation packages consume.
 *
 * `NormalizedEvent` is the contract between adopter-specific event sources
 * (one markdown file per event, a bullet list in README, a YAML data file,
 * a CMS) and coopkit's automation packages (`@coopkit/meetup`,
 * `@coopkit/banners`, `@coopkit/social`).
 *
 * Each adopter writes a small extractor in their own repo that produces
 * `NormalizedEvent[]` from whatever source they use. Coopkit packages
 * operate exclusively on this shape and never read the original source.
 *
 * Fields are kept minimal on purpose. Adopters who need to carry extra
 * data through to a callback can stash it in `raw`.
 */
export interface NormalizedEvent {
  /**
   * Stable identifier for this event. Used for logs, bookkeeping
   * (e.g. as a key in an `events.yml`), and dedup. The shape is up to the
   * adopter — a filename slug, a `YYYY-MM-DD-speaker-slug` derivation, or
   * a hash.
   */
  id: string;

  /** Event start, as a real Date. */
  date: Date;

  /** Event title — used as the Meetup title, banner text, post text. */
  title: string;

  /**
   * Human-readable description. Plain text or Markdown — packages that
   * forward this (e.g. Meetup's `description` field) accept Markdown.
   */
  description?: string;

  /** ISO-8601 duration string (e.g. "PT2H"). Required by @coopkit/meetup. */
  duration?: string;

  /**
   * Venue key for resolution against the adopter's venue map. Required by
   * @coopkit/meetup for physical events. Free-form string; must match
   * exactly a key in the venue map passed to the package.
   */
  venueKey?: string;

  /** Speaker / presenter for this event. Drives banner avatar + social copy. */
  speaker?: NormalizedSpeaker;

  /** Current banner URL (if any) — consumed by Meetup as the featured photo. */
  imageUrl?: string;

  /** Public URL of the recording, once available. */
  recordingUrl?: string;

  /** Public URL where attendees register. */
  registrationUrl?: string;

  /**
   * Adapter-specific original payload. Carried through to callbacks so
   * adopters can write back to their source (frontmatter, events.yml, etc.).
   */
  raw?: unknown;
}

export interface NormalizedSpeaker {
  name: string;
  /** URL or absolute filesystem path of the headshot. */
  avatarUrl?: string;
  /** Speaker bio in Markdown. */
  bioMarkdown?: string;
}
