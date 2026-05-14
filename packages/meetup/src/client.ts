import fs from "node:fs";
import jwt from "jsonwebtoken";

const MEETUP_GQL_URL = "https://api.meetup.com/gql-ext";
const MEETUP_TOKEN_URL = "https://secure.meetup.com/oauth2/access";

export interface MeetupCredentials {
  clientKey: string;
  memberId: string;
  privateKeyPath: string;
  signingKeyId: string;
}

export interface MeetupGraphQLError {
  message: string;
  code?: string;
  field?: string;
}

export class MeetupApiError extends Error {
  public readonly errors?: MeetupGraphQLError[];
  public readonly status?: number;

  constructor(message: string, errors?: MeetupGraphQLError[], status?: number) {
    super(message);
    this.name = "MeetupApiError";
    this.errors = errors;
    this.status = status;
  }
}

export interface MeetupClient {
  graphql: <T = unknown>(query: string, variables?: Record<string, unknown>) => Promise<T>;
  uploadPhoto: (uploadUrl: string, body: Buffer, contentType?: string) => Promise<void>;
}

function readEnvCredentials(): MeetupCredentials {
  const clientKey = process.env.MEETUP_CLIENT_KEY;
  const memberId = process.env.MEETUP_MEMBER_ID;
  const privateKeyPath = process.env.MEETUP_PRIVATE_KEY_PATH;
  const signingKeyId = process.env.MEETUP_SIGNING_KEY_ID;
  if (!clientKey || !memberId || !privateKeyPath || !signingKeyId) {
    throw new Error(
      "Missing Meetup credentials. Set MEETUP_CLIENT_KEY, MEETUP_MEMBER_ID, " +
        "MEETUP_PRIVATE_KEY_PATH, and MEETUP_SIGNING_KEY_ID in .env or the environment."
    );
  }
  return { clientKey, memberId, privateKeyPath, signingKeyId };
}

/**
 * Create a Meetup GraphQL client authenticated via JWT-Bearer OAuth.
 *
 * Credentials default to the standard environment variables (MEETUP_CLIENT_KEY,
 * MEETUP_MEMBER_ID, MEETUP_PRIVATE_KEY_PATH, MEETUP_SIGNING_KEY_ID). Pass an
 * explicit `MeetupCredentials` object to override.
 */
export function createMeetupClient(credentials?: MeetupCredentials): MeetupClient {
  const env = credentials ?? readEnvCredentials();
  let accessToken: string | null = null;
  let tokenExpiresAt = 0;

  async function authenticate(): Promise<string> {
    const privateKey = fs.readFileSync(env.privateKeyPath, "utf8");
    const now = Math.floor(Date.now() / 1000);
    const signed = jwt.sign(
      { sub: env.memberId, iss: env.clientKey, aud: "api.meetup.com", exp: now + 120 },
      privateKey,
      { algorithm: "RS256", header: { alg: "RS256", typ: "JWT", kid: env.signingKeyId } }
    );

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signed,
    });

    const response = await fetch(MEETUP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new MeetupApiError(
        `OAuth2 token exchange failed: ${response.status} ${response.statusText}\n${text}`,
        undefined,
        response.status
      );
    }

    const data = (await response.json()) as { access_token: string; expires_in?: number };
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
    return accessToken;
  }

  async function getToken(): Promise<string> {
    if (!accessToken || Date.now() >= tokenExpiresAt) {
      return authenticate();
    }
    return accessToken;
  }

  async function graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    const token = await getToken();
    const response = await fetch(MEETUP_GQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new MeetupApiError(
        `Meetup GraphQL HTTP ${response.status}: ${text}`,
        undefined,
        response.status
      );
    }

    const json = (await response.json()) as {
      data?: T;
      errors?: MeetupGraphQLError[];
    };
    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message).join("; ");
      throw new MeetupApiError(`Meetup GraphQL error: ${msg}`, json.errors);
    }
    if (json.data === undefined) {
      throw new MeetupApiError("Meetup GraphQL response is missing `data`.");
    }
    return json.data;
  }

  async function uploadPhoto(
    uploadUrl: string,
    body: Buffer,
    contentType = "image/jpeg"
  ): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new MeetupApiError(
        `Meetup photo upload failed ${response.status}: ${text}`,
        undefined,
        response.status
      );
    }
  }

  return { graphql, uploadPhoto };
}
