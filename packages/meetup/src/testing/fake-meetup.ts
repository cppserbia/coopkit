// Test-only stand-in for Meetup's HTTP surface: the OAuth token endpoint, the
// gql-ext operations createMeetupDraft uses, photo upload URLs, and image
// downloads. It replaces globalThis.fetch, so the non-dry-run paths run offline
// against the real client; a request it does not recognize throws instead of
// reaching the network. Excluded from the published build (tsconfig.build.json).
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeetupCredentials } from "../client.js";

const TOKEN_URL = "https://secure.meetup.com/oauth2/access";
const GQL_URL = "https://api.meetup.com/gql-ext";
const UPLOAD_PREFIX = "https://upload.fake.test/photo/";

/**
 * Images under this host download as a PNG, except a path containing
 * "missing", which 404s. Images anywhere else are unexpected requests.
 */
export const IMAGE_HOST = "https://images.fake.test";

const GQL_FIELDS = ["groupByUrlname", "createEvent", "createGroupEventPhoto", "editEvent"] as const;

export interface FakeMeetupOptions {
  /** createGroupEventPhoto returns an error for non-main (speaker) photos. */
  failSpeakerPhotoUpload?: boolean;
  /** editEvent returns no event and an error. */
  failEditEvent?: boolean;
  /** Photo ID createGroupEventPhoto hands back for non-main photos. */
  speakerPhotoId?: string;
  /** Group urlnames (case-insensitive) whose createEvent returns no event and an error. */
  failCreateEventIn?: string[];
  /** ID of the first event createEvent hands out; each later one counts up. Default 900001. */
  firstEventId?: number;
}

/** One request the fake answered. */
export interface FakeCall {
  /** "token", "image", "upload", or the GraphQL root field (e.g. "createEvent"). */
  op: string;
  url: string;
  /** GraphQL `input` variable, or the variables object when there is no input. */
  input?: Record<string, unknown>;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

export function createFakeMeetup(options: FakeMeetupOptions = {}) {
  const calls: FakeCall[] = [];
  let nextEventId = options.firstEventId ?? 900_001;
  const lower = (value: unknown) => String(value).toLowerCase();
  let nextPhotoId = 500_001;

  function answer(op: (typeof GQL_FIELDS)[number], input: Record<string, unknown>): unknown {
    switch (op) {
      case "groupByUrlname":
        return { id: "4242" };
      case "createEvent": {
        if ((options.failCreateEventIn ?? []).some((g) => lower(g) === lower(input.groupUrlname))) {
          return {
            event: null,
            errors: [
              { message: "Not allowed in this group", code: "FORBIDDEN", field: "groupUrlname" },
            ],
          };
        }
        const id = String(nextEventId++);
        return {
          event: { id, eventUrl: `https://www.meetup.com/${input.groupUrlname}/events/${id}/` },
          errors: [],
        };
      }
      case "createGroupEventPhoto": {
        if (!input.setAsMain && options.failSpeakerPhotoUpload) {
          return {
            photo: null,
            uploadUrl: null,
            error: { message: "Photo rejected", code: "INVALID", field: "photoType" },
          };
        }
        const id = String(nextPhotoId++);
        const photoId = input.setAsMain ? id : (options.speakerPhotoId ?? id);
        return { photo: { id: photoId }, uploadUrl: `${UPLOAD_PREFIX}${id}`, error: null };
      }
      case "editEvent":
        return options.failEditEvent
          ? {
              event: null,
              errors: [
                { message: "Invalid photo", code: "INVALID", field: "speakerDetails.photoId" },
              ],
            }
          : { event: { id: input.eventId }, errors: [] };
    }
  }

  async function handle(url: string, init: RequestInit | undefined): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === TOKEN_URL && method === "POST") {
      calls.push({ op: "token", url });
      return Response.json({ access_token: "fake-token", expires_in: 3600 });
    }

    if (url === GQL_URL && method === "POST") {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const op = GQL_FIELDS.find((field) => query.includes(`${field}(`));
      if (!op) throw new Error(`fake Meetup: unhandled GraphQL operation:\n${query}`);
      const input = (variables.input ?? variables) as Record<string, unknown>;
      calls.push({ op, url, input });
      return Response.json({ data: { [op]: answer(op, input) } });
    }

    if (url.startsWith(UPLOAD_PREFIX) && method === "PUT") {
      calls.push({ op: "upload", url });
      return new Response(null, { status: 200 });
    }

    if (url.startsWith(`${IMAGE_HOST}/`) && method === "GET") {
      calls.push({ op: "image", url });
      if (url.includes("missing")) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      });
    }

    throw new Error(`fake Meetup: unexpected ${method} ${url}`);
  }

  return {
    calls,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      handle(urlOf(input), init)) as unknown as typeof fetch,
    /** Every call but the token exchange, by op name, in order. */
    ops: (): string[] => calls.filter((c) => c.op !== "token").map((c) => c.op),
    /** The `input` of each call to a GraphQL root field, in order. */
    inputs: (op: string): Array<Record<string, unknown>> =>
      calls.filter((c) => c.op === op).map((c) => c.input ?? {}),
  };
}

/**
 * Credentials backed by a throwaway RSA key, so the real client can sign its
 * JWT without any secrets. The key is removed when the process exits.
 */
export function fakeCredentials(): MeetupCredentials {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const dir = mkdtempSync(join(tmpdir(), "coopkit-fake-meetup-"));
  const privateKeyPath = join(dir, "key.pem");
  writeFileSync(privateKeyPath, privateKey);
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return { clientKey: "fake-client", memberId: "1", privateKeyPath, signingKeyId: "fake-kid" };
}
