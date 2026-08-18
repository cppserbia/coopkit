export { createMeetupClient, MeetupApiError } from "./client.js";
export type {
  MeetupClient,
  MeetupCredentials,
  MeetupGraphQLError,
} from "./client.js";

export { ONLINE_VENUE_ID, resolveVenueId } from "./venues.js";
export type { VenueId, VenueMap } from "./venues.js";

export {
  buildCreateEventPayload,
  buildCreateEventPayloadWithMap,
  detectContentType,
  isEventAlreadyCreated,
  stripLeadingHeading,
  wallTimeInZone,
} from "./payload.js";
export type { BuildPayloadInput, CreateEventPayload } from "./payload.js";

export {
  createMeetupDraft,
  createMeetupDraftFromFile,
  createMeetupDrafts,
} from "./create-event.js";
export type {
  CreateMeetupDraftFromFileOptions,
  CreateMeetupDraftFromFileResult,
  CreateMeetupDraftOptions,
  CreateMeetupDraftResult,
  CreateMeetupDraftsOptions,
  CreateMeetupDraftsResult,
} from "./create-event.js";

export { fetchAllVenues, formatVenueKey, listVenues } from "./list-venues.js";
export type { ListVenuesOptions, MeetupVenue } from "./list-venues.js";

export {
  DEFAULT_CONFIG_FILENAME,
  groupAcceptsSpeaker,
  loadMeetupConfig,
  resolveGroupTargets,
  resolveHostIds,
} from "./config.js";
export type { CoopkitConfig, GroupTarget, MeetupConfig } from "./config.js";

export { classifySocialUrl, speakerDetailsFrom } from "./speaker.js";
export type { SocialNetworkService, SpeakerDetailsInput } from "./speaker.js";

export { listGroups } from "./list-groups.js";
export type { ListGroupsOptions, MeetupGroupInfo } from "./list-groups.js";
