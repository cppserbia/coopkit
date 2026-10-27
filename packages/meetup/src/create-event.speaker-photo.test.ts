// The speaker photo path past dry-run: createMeetupDraft against the fake
// Meetup in testing/fake-meetup.ts, which stands in for fetch, so the real
// client, mutations and upload run with no network and no credentials.
//
// The photo is opt-in (includeSpeakerPhoto), so draft() opts in by default and
// "without the opt-in" below checks that leaving it out changes nothing.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { NormalizedEvent } from "@coopkit/core";
import type { MeetupCredentials } from "./client.js";
import {
  type CreateMeetupDraftOptions,
  createMeetupDraft,
  createMeetupDrafts,
} from "./create-event.js";
import {
  type FakeMeetupOptions,
  IMAGE_HOST,
  createFakeMeetup,
  fakeCredentials,
} from "./testing/fake-meetup.js";

const AVATAR = `${IMAGE_HOST}/andy-soffer.png`;

const EVENT: NormalizedEvent = {
  id: "2026-08-22-andy-soffer",
  title: "(GlobalCpp) Refactoring C++ Today",
  date: new Date("2026-08-22T16:00:00Z"),
  duration: "PT1H",
  venueKey: "online",
  description: "A pragmatic survey.",
  speaker: {
    name: "Andy Soffer",
    bioMarkdown: "A lapsed mathematician turned software engineer.",
    socialUrls: ["https://www.linkedin.com/in/someone/"],
    avatarUrl: AVATAR,
  },
};

const realFetch = globalThis.fetch;
let credentials: MeetupCredentials;
let fake: ReturnType<typeof createFakeMeetup>;
let logs: string[];

beforeAll(() => {
  credentials = fakeCredentials();
});

beforeEach(() => {
  useFake();
  logs = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function useFake(options: FakeMeetupOptions = {}): void {
  fake = createFakeMeetup(options);
  globalThis.fetch = fake.fetch;
}

/** A run that sends the speaker profile, as a caller from v0.3.0 would make it. */
function draftWithoutOptIn(overrides: Partial<CreateMeetupDraftOptions> = {}) {
  return createMeetupDraft({
    event: EVENT,
    groupUrlname: "cpp-serbia",
    venues: { online: "online" },
    includeSpeaker: true,
    credentials,
    log: (m) => logs.push(m),
    ...overrides,
  });
}

/** The same run, opted into the speaker photo. */
function draft(overrides: Partial<CreateMeetupDraftOptions> = {}) {
  return draftWithoutOptIn({ includeSpeakerPhoto: true, ...overrides });
}

function withSpeaker(patch: Partial<NonNullable<NormalizedEvent["speaker"]>>): NormalizedEvent {
  return { ...EVENT, speaker: { ...EVENT.speaker!, ...patch } };
}

describe("speaker photo: happy path", () => {
  it("creates the event first, then uploads the headshot and sets it via editEvent", async () => {
    const result = await draft();

    expect(fake.ops()).toEqual([
      "createEvent",
      "groupByUrlname",
      "image",
      "createGroupEventPhoto",
      "upload",
      "editEvent",
    ]);
    expect(result).toEqual({
      status: "created",
      eventId: "900001",
      eventUrl: "https://www.meetup.com/cpp-serbia/events/900001/",
      photoAttached: false,
      speakerPhotoAttached: true,
    });
  });

  it("creates the event with the speaker profile but no photoId", async () => {
    await draft();
    const [create] = fake.inputs("createEvent");
    expect(create?.speakerDetails).toEqual({
      name: "Andy Soffer",
      description: "A lapsed mathematician turned software engineer.",
      socialNetworks: [{ service: "LINKEDIN", identifier: "https://www.linkedin.com/in/someone/" }],
    });
  });

  it("uploads the headshot as an event photo that is not the featured one", async () => {
    await draft();
    expect(fake.inputs("createGroupEventPhoto")).toEqual([
      {
        groupId: "4242",
        eventId: "900001",
        photoType: "EVENT_PHOTO",
        contentType: "PNG",
        setAsMain: false,
      },
    ]);
  });

  it("re-sends the whole speaker profile with photoId added", async () => {
    await draft();
    const [create] = fake.inputs("createEvent");
    expect(fake.inputs("editEvent")).toEqual([
      {
        eventId: "900001",
        speakerDetails: { ...(create?.speakerDetails as object), photoId: "500001" },
      },
    ]);
  });

  it("keeps the banner as the featured photo and looks the group up once", async () => {
    const result = await draft({
      event: { ...EVENT, imageUrl: `${IMAGE_HOST}/banner.png` },
    });

    expect(fake.inputs("createGroupEventPhoto").map((i) => i.setAsMain)).toEqual([true, false]);
    expect(fake.inputs("groupByUrlname")).toHaveLength(1);
    // The banner took 500001, so the headshot is 500002.
    expect(fake.inputs("editEvent")[0]?.speakerDetails).toMatchObject({ photoId: "500002" });
    expect(result).toMatchObject({ photoAttached: true, speakerPhotoAttached: true });
  });

  it("reports speakerPhotoAttached to onCreated, after editEvent", async () => {
    let seen: { speakerPhotoAttached: boolean; opsSoFar: string[] } | undefined;
    await draft({
      onCreated: ({ result }) => {
        seen = { speakerPhotoAttached: result.speakerPhotoAttached, opsSoFar: fake.ops() };
      },
    });
    expect(seen?.speakerPhotoAttached).toBe(true);
    expect(seen?.opsSoFar.at(-1)).toBe("editEvent");
  });
});

describe("speaker photo: failures never cost the draft", () => {
  const cases: Array<{
    name: string;
    fakeOptions?: FakeMeetupOptions;
    event?: NormalizedEvent;
    lastOp: string;
    warning: RegExp;
  }> = [
    {
      name: "the headshot cannot be downloaded",
      event: withSpeaker({ avatarUrl: `${IMAGE_HOST}/missing.png` }),
      lastOp: "image",
      warning: /Failed to fetch image .*missing\.png: 404/,
    },
    {
      name: "createGroupEventPhoto rejects the upload",
      fakeOptions: { failSpeakerPhotoUpload: true },
      lastOp: "createGroupEventPhoto",
      warning: /createGroupEventPhoto failed: Photo rejected/,
    },
    {
      name: "the photo ID is not a positive integer",
      fakeOptions: { speakerPhotoId: "0" },
      lastOp: "upload",
      warning: /photo id "0"/,
    },
    {
      name: "editEvent refuses the photoId",
      fakeOptions: { failEditEvent: true },
      lastOp: "editEvent",
      warning: /editEvent did not set the speaker photo\. speakerDetails\.photoId: Invalid photo/,
    },
  ];

  for (const c of cases) {
    it(`creates the draft and warns when ${c.name}`, async () => {
      useFake(c.fakeOptions);
      let onCreatedResult: unknown;
      const result = await draft({
        ...(c.event ? { event: c.event } : {}),
        onCreated: ({ result }) => {
          onCreatedResult = result;
        },
      });

      expect(result).toMatchObject({
        status: "created",
        eventId: "900001",
        speakerPhotoAttached: false,
      });
      expect(onCreatedResult).toMatchObject({ eventId: "900001", speakerPhotoAttached: false });
      expect(fake.ops().at(-1)).toBe(c.lastOp);
      // The profile itself went out with createEvent and is not touched again.
      expect(fake.inputs("createEvent")[0]?.speakerDetails).toBeDefined();
      const warning = logs.find((m) => m.startsWith("[warn] Speaker photo failed"));
      expect(warning).toMatch(c.warning);
    });
  }
});

describe("speaker photo: when it is not attempted", () => {
  it("skips it for a group that does not accept speaker profiles", async () => {
    const result = await draft({ includeSpeaker: false });
    expect(fake.ops()).toEqual(["createEvent"]);
    expect(fake.inputs("createEvent")[0]?.speakerDetails).toBeUndefined();
    expect(result).toMatchObject({ speakerPhotoAttached: false });
  });

  it("skips it when the profile itself was not sent (no bio)", async () => {
    const result = await draft({ event: withSpeaker({ bioMarkdown: undefined }) });
    expect(fake.ops()).toEqual(["createEvent"]);
    expect(result).toMatchObject({ speakerPhotoAttached: false });
  });

  it("does not judge avatarUrl when there is no profile to put it on", async () => {
    await draft({ includeSpeaker: false, event: withSpeaker({ avatarUrl: "/srv/a.png" }) });
    expect(fake.ops()).toEqual(["createEvent"]);
    expect(logs.some((m) => /speaker photo/i.test(m))).toBe(false);
  });

  it("skips it when the speaker has no avatarUrl", async () => {
    const result = await draft({ event: withSpeaker({ avatarUrl: undefined }) });
    expect(fake.ops()).toEqual(["createEvent"]);
    expect(fake.inputs("createEvent")[0]?.speakerDetails).toBeDefined();
    expect(result).toMatchObject({ speakerPhotoAttached: false });
    expect(logs.some((m) => m.includes("Speaker photo"))).toBe(false);
  });

  it("skips a filesystem path with a warning, since only URLs are fetched", async () => {
    const result = await draft({ event: withSpeaker({ avatarUrl: "/srv/avatars/andy.png" }) });
    expect(fake.ops()).toEqual(["createEvent"]);
    expect(fake.inputs("createEvent")[0]?.speakerDetails).toBeDefined();
    expect(result).toMatchObject({ speakerPhotoAttached: false });
    expect(logs).toContain(
      '[warn] Speaker photo skipped: avatarUrl must be an http(s) URL, got "/srv/avatars/andy.png".'
    );
  });
});

describe("speaker photo: dry run", () => {
  it("makes no requests and says the photo would be uploaded", async () => {
    const result = await draft({ dryRun: true });

    expect(fake.calls).toEqual([]);
    expect(result.status).toBe("dry-run");
    if (result.status !== "dry-run") throw new Error("unreachable");
    expect(result.payload.speakerDetails && "photoId" in result.payload.speakerDetails).toBe(false);
    expect(logs).toContain(
      `--- DRY RUN: would then upload speaker photo ${AVATAR} and set it via editEvent ---`
    );
  });

  it("says nothing about a speaker photo when none would be uploaded", async () => {
    await draft({ dryRun: true, includeSpeaker: false });
    expect(fake.calls).toEqual([]);
    expect(logs.some((m) => m.includes("speaker photo"))).toBe(false);
  });
});

describe("speaker photo: without the opt-in", () => {
  // Everything here would attach the photo with includeSpeakerPhoto: true.
  // Without it, avatarUrl is ignored as it was before the photo existed.
  it("sends the profile but never uploads the headshot or calls editEvent", async () => {
    let onCreatedResult: unknown;
    const result = await draftWithoutOptIn({
      onCreated: ({ result }) => {
        onCreatedResult = result;
      },
    });

    expect(fake.ops()).toEqual(["createEvent"]);
    expect(fake.inputs("createEvent")[0]?.speakerDetails).toBeDefined();
    expect(result).toEqual({
      status: "created",
      eventId: "900001",
      eventUrl: "https://www.meetup.com/cpp-serbia/events/900001/",
      photoAttached: false,
      speakerPhotoAttached: false,
    });
    expect(onCreatedResult).toMatchObject({ speakerPhotoAttached: false });
    expect(logs.some((m) => /speaker photo/i.test(m))).toBe(false);
  });

  it("still uploads the featured photo, and only that", async () => {
    const result = await draftWithoutOptIn({
      event: { ...EVENT, imageUrl: `${IMAGE_HOST}/banner.png` },
    });

    expect(fake.ops()).toEqual([
      "createEvent",
      "groupByUrlname",
      "image",
      "createGroupEventPhoto",
      "upload",
    ]);
    expect(fake.inputs("createGroupEventPhoto").map((i) => i.setAsMain)).toEqual([true]);
    expect(result).toMatchObject({ photoAttached: true, speakerPhotoAttached: false });
    expect(logs.some((m) => /speaker photo/i.test(m))).toBe(false);
  });

  it("does not warn about an avatarUrl it would not have used", async () => {
    await draftWithoutOptIn({ event: withSpeaker({ avatarUrl: "/srv/avatars/andy.png" }) });
    expect(fake.ops()).toEqual(["createEvent"]);
    expect(logs.some((m) => /speaker photo/i.test(m))).toBe(false);
  });

  it("says nothing about a speaker photo in a dry run", async () => {
    await draftWithoutOptIn({ dryRun: true });
    expect(fake.calls).toEqual([]);
    expect(logs.some((m) => /speaker photo/i.test(m))).toBe(false);
  });

  it("treats an explicit includeSpeakerPhoto: false the same as leaving it out", async () => {
    const result = await draft({ includeSpeakerPhoto: false });
    expect(fake.ops()).toEqual(["createEvent"]);
    expect(result).toMatchObject({ speakerPhotoAttached: false });
  });
});

describe("speaker photo across groups", () => {
  it("attaches it only in the groups that take speaker profiles", async () => {
    const { results } = await createMeetupDrafts({
      event: EVENT,
      groups: [
        {
          urlname: "cpp-serbia",
          includeSpeaker: true,
          includeSpeakerPhoto: true,
          timezone: "Europe/Belgrade",
        },
        {
          urlname: "chicago-c-cpp-users-group",
          includeSpeakerPhoto: true,
          timezone: "America/Chicago",
        },
      ],
      venues: { online: "online" },
      credentials,
      log: () => {},
    });

    const attached = results.map((r) =>
      r.ok && r.result.status === "created" ? r.result.speakerPhotoAttached : undefined
    );
    expect(attached).toEqual([true, false]);
    expect(fake.inputs("editEvent").map((i) => i.eventId)).toEqual(["900001"]);
  });

  it("attaches it only in the groups that opted into the photo", async () => {
    const { results } = await createMeetupDrafts({
      event: EVENT,
      groups: [
        { urlname: "cpp-serbia", includeSpeaker: true, timezone: "Europe/Belgrade" },
        {
          urlname: "chicago-c-cpp-users-group",
          includeSpeaker: true,
          includeSpeakerPhoto: true,
          timezone: "America/Chicago",
        },
      ],
      venues: { online: "online" },
      credentials,
      log: (m) => logs.push(m),
    });

    const attached = results.map((r) =>
      r.ok && r.result.status === "created" ? r.result.speakerPhotoAttached : undefined
    );
    expect(attached).toEqual([false, true]);
    // Both groups got the profile; only the second got the photo.
    expect(fake.inputs("createEvent").map((i) => Boolean(i.speakerDetails))).toEqual([true, true]);
    expect(fake.inputs("editEvent").map((i) => i.eventId)).toEqual(["900002"]);
    expect(logs.filter((m) => m.startsWith("Uploading speaker photo"))).toHaveLength(1);
  });
});
