import type { NormalizedSpeaker } from "@coopkit/core";

/**
 * Meetup's speaker profile on an event — a Meetup **Pro** feature, which is why
 * sending it is opt-in per group (see `MeetupConfig.speakerDetails`). Groups
 * outside a Pro network reject it.
 */
export interface SpeakerDetailsInput {
  name: string;
  description: string;
  socialNetworks?: Array<{ service: SocialNetworkService; identifier: string }>;
}

/** The services Meetup's SocialNetworkService enum accepts. */
export type SocialNetworkService =
  | "FACEBOOK"
  | "FLICKR"
  | "INSTAGRAM"
  | "LINKEDIN"
  | "OTHER"
  | "TIKTOK"
  | "TUMBLR"
  | "TWITTER";

const HOST_SERVICES: Array<[RegExp, SocialNetworkService]> = [
  [/(^|\.)linkedin\.com$/i, "LINKEDIN"],
  [/(^|\.)(twitter\.com|x\.com)$/i, "TWITTER"],
  [/(^|\.)instagram\.com$/i, "INSTAGRAM"],
  [/(^|\.)facebook\.com$/i, "FACEBOOK"],
  [/(^|\.)tiktok\.com$/i, "TIKTOK"],
  [/(^|\.)tumblr\.com$/i, "TUMBLR"],
  [/(^|\.)flickr\.com$/i, "FLICKR"],
];

/**
 * Classify a profile URL into Meetup's fixed service enum, falling back to
 * OTHER — which is what a personal site or a Mastodon instance is.
 *
 * The whole URL is kept as the `identifier`. Meetup calls the field an
 * identifier, suggesting a bare handle, but the shape it wants per service is
 * undocumented, and a URL is unambiguous and lossless for every service
 * including OTHER.
 */
export function classifySocialUrl(
  url: string
): { service: SocialNetworkService; identifier: string } | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined; // not a URL we can classify; drop it rather than guess
  }

  const matched = HOST_SERVICES.find(([re]) => re.test(host));
  return { service: matched ? matched[1] : "OTHER", identifier: url };
}

/**
 * Build Meetup's speakerDetails from a NormalizedEvent's speaker.
 *
 * Returns undefined when there is no speaker, or no bio: Meetup requires a
 * non-empty `description`, and inventing one (or sending an empty string) would
 * publish a hollow speaker profile. The caller logs the skip.
 */
export function speakerDetailsFrom(
  speaker: NormalizedSpeaker | undefined
): SpeakerDetailsInput | undefined {
  if (!speaker?.name?.trim()) return undefined;

  const description = speaker.bioMarkdown?.trim();
  if (!description) return undefined;

  const details: SpeakerDetailsInput = { name: speaker.name.trim(), description };

  const socialNetworks = (speaker.socialUrls ?? [])
    .map((url) => classifySocialUrl(url))
    .filter((entry): entry is { service: SocialNetworkService; identifier: string } => !!entry);
  if (socialNetworks.length > 0) details.socialNetworks = socialNetworks;

  return details;
}
