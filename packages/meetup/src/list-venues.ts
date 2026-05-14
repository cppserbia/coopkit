import { createMeetupClient, type MeetupClient, type MeetupCredentials } from "./client.js";

export interface MeetupVenue {
  id: string;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
}

interface VenueEdge {
  cursor: string;
  node: MeetupVenue;
}

interface VenuesPage {
  edges: VenueEdge[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
}

const GROUP_VENUES_QUERY = `
  query GroupVenues($urlname: String!, $first: Int!, $after: String) {
    groupByUrlname(urlname: $urlname) {
      id
      venues(first: $first, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        edges {
          cursor
          node {
            id
            name
            address
            city
            state
            country
            postalCode
          }
        }
      }
    }
  }
`;

interface GroupVenuesResult {
  groupByUrlname: { id: string; venues: VenuesPage } | null;
}

export async function fetchAllVenues(
  client: MeetupClient,
  urlname: string
): Promise<MeetupVenue[]> {
  const venues: MeetupVenue[] = [];
  let after: string | null = null;

  for (;;) {
    const data: GroupVenuesResult = await client.graphql<GroupVenuesResult>(GROUP_VENUES_QUERY, {
      urlname,
      first: 50,
      after,
    });

    const group = data.groupByUrlname;
    if (!group) {
      throw new Error(`Meetup group not found: "${urlname}"`);
    }

    for (const edge of group.venues.edges) venues.push(edge.node);

    if (!group.venues.pageInfo.hasNextPage) break;
    after = group.venues.pageInfo.endCursor;
    if (!after) break;
  }

  return venues;
}

export function formatVenueKey(v: MeetupVenue): string {
  const parts = [v.name, v.city, v.country].filter((p): p is string => !!p && p.length > 0);
  return parts.join(", ");
}

export interface ListVenuesOptions {
  groupUrlname: string;
  credentials?: MeetupCredentials;
}

/**
 * Fetch all venues registered against a Meetup group. Useful for populating
 * the `meetup.venues` map in coopkit.config.json.
 */
export async function listVenues(options: ListVenuesOptions): Promise<MeetupVenue[]> {
  const client = createMeetupClient(options.credentials);
  return fetchAllVenues(client, options.groupUrlname);
}
