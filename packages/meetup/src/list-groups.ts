import { type MeetupClient, type MeetupCredentials, createMeetupClient } from "./client.js";

export interface MeetupGroupInfo {
  urlname: string;
  name: string | null;
  /** IANA timezone Meetup holds for the group — what it reads event times in. */
  timezone: string | null;
}

const GROUP_INFO_QUERY = `
  query GroupInfo($urlname: String!) {
    groupByUrlname(urlname: $urlname) {
      urlname
      name
      timezone
    }
  }
`;

export interface ListGroupsOptions {
  urlnames: string[];
  client?: MeetupClient;
  credentials?: MeetupCredentials;
}

/**
 * Look up each group's canonical urlname, name and timezone.
 *
 * The timezone is the point: Meetup interprets an event's `startDateTime` as
 * wall time in the group's own zone, so cross-posting one session to several
 * groups needs each group's zone to land on the same instant. A group that
 * cannot be read comes back with nulls rather than aborting the whole listing.
 */
export async function listGroups(options: ListGroupsOptions): Promise<MeetupGroupInfo[]> {
  const client = options.client ?? createMeetupClient(options.credentials);

  const out: MeetupGroupInfo[] = [];
  for (const urlname of options.urlnames) {
    try {
      const data = await client.graphql<{ groupByUrlname: MeetupGroupInfo | null }>(
        GROUP_INFO_QUERY,
        { urlname }
      );
      const group = data.groupByUrlname;
      out.push({
        urlname: group?.urlname ?? urlname,
        name: group?.name ?? null,
        timezone: group?.timezone ?? null,
      });
    } catch {
      out.push({ urlname, name: null, timezone: null });
    }
  }
  return out;
}
