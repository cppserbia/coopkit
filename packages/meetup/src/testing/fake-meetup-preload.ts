// `bun --preload` entry that puts the fake Meetup into a spawned CLI process,
// so cli.test.ts can run the real bin past dry-run without network or secrets.
// COOPKIT_FAKE_MEETUP holds the FakeMeetupOptions as JSON ("{}" for defaults).
// COOPKIT_FAKE_MEETUP_CALLS, if set, is a path the requests the fake answered
// are written to as JSON when the process exits, for the test to inspect.
import { writeFileSync } from "node:fs";
import { type FakeMeetupOptions, createFakeMeetup, fakeCredentials } from "./fake-meetup.js";

const options = JSON.parse(process.env.COOPKIT_FAKE_MEETUP || "{}") as FakeMeetupOptions;
const credentials = fakeCredentials();
const fake = createFakeMeetup(options);

process.env.MEETUP_CLIENT_KEY = credentials.clientKey;
process.env.MEETUP_MEMBER_ID = credentials.memberId;
process.env.MEETUP_PRIVATE_KEY_PATH = credentials.privateKeyPath;
process.env.MEETUP_SIGNING_KEY_ID = credentials.signingKeyId;
globalThis.fetch = fake.fetch;

const callsPath = process.env.COOPKIT_FAKE_MEETUP_CALLS;
if (callsPath) process.on("exit", () => writeFileSync(callsPath, JSON.stringify(fake.calls)));
