# @coopkit/meetup

> Create Meetup.com Draft events from anywhere — a markdown file, a form input, a `NormalizedEvent` in your own code.

Library + CLI for creating Meetup.com Draft events. Part of the [coopkit](https://github.com/cppserbia/coopkit) toolkit.

Three usage patterns:

| Pattern | Best for | API |
|---|---|---|
| **File-per-event** | Repos with `events/YYYY-MM-DD-Title.md` (cppserbia-style) | `createMeetupDraftFromFile()` / `coopkit-meetup create <file>` |
| **Form input** | Manually-triggered GitHub workflows | `coopkit-meetup create-from-json` reading stdin or a JSON file |
| **Custom source** | Bullet lists, YAML data, CMS, anywhere else | `createMeetupDraft({event: NormalizedEvent, ...})` library API |

## Install

```bash
npm install @coopkit/meetup
# or: bun add @coopkit/meetup
```

> Ships compiled ESM + type declarations. Works under **Node 18+** and **Bun 1.3+**. The CLI is available as `coopkit-meetup` (run via `npx coopkit-meetup …` or `bunx coopkit-meetup …`).

## One-time Meetup OAuth setup

1. Create a Meetup OAuth app at <https://www.meetup.com/api/oauth/create/>. Grant the **`event_management`** scope; `createEvent` 403s without it.
2. In the app settings, **JWT Signing Keys → Generate Key**. Save the private-key PEM file and note the **Key ID**.
3. Find your Meetup **member ID**. The account must be an **organizer** of the target group.

Set these environment variables:

| Var | Purpose |
| --- | --- |
| `MEETUP_CLIENT_KEY` | OAuth consumer key |
| `MEETUP_MEMBER_ID` | Your Meetup member ID |
| `MEETUP_SIGNING_KEY_ID` | JWT signing key ID |
| `MEETUP_PRIVATE_KEY_PATH` | Path to the private-key PEM file |

## Config file

Drop a `coopkit.config.json` at the repo root:

```json
{
  "meetup": {
    "groupUrlname": "your-group-slug",
    "timezone": "America/Chicago",
    "venues": {
      "Venue Name, City, cc": 12345678,
      "online": "online"
    },
    "hosts": {
      "Rob Douglas": 13296813
    },
    "defaultHosts": ["Rob Douglas"]
  }
}
```

| Key | Required | Purpose |
| --- | --- | --- |
| `groupUrlname` | yes | Meetup group slug the drafts are created in. |
| `venues` | yes | Maps frontmatter venue keys to Meetup venue IDs. |
| `timezone` | no | IANA zone of the group. **Set this if your event dates are true UTC** — see below. A multi-group run never applies it to every group; see [network events](#network-events-one-session-several-groups). |
| `groupTimezones` | no | Per-group IANA zone for a multi-group run. A group missing here is looked up from Meetup; pin it here to skip the lookup. A dry run needs it. |
| `hosts` | no | Named Meetup member IDs, so you can refer to hosts by name. |
| `defaultHosts` | no | Names from `hosts` used when an event names none. |

### Online events

Meetup has no venue record for an online event, so `list-venues` will never
return one. Use the literal string `"online"` as the venue ID:

```json
"venues": { "online": "online" }
```

### Timezones — read this if your dates are UTC

Meetup interprets `startDateTime` as **wall time in the group's own timezone**;
the API accepts no offset. So `event.date` has two possible readings, and the
`timezone` key picks which one you mean:

- **`timezone` set** — `event.date` is a true instant and gets converted to wall
  time in that zone. `date: 2026-08-22T16:00:00Z` with
  `"timezone": "America/Chicago"` creates an **11:00** event. DST is handled per
  date.
- **`timezone` omitted** — `event.date`'s UTC clock reading is used verbatim, so
  `2026-08-14T18:00:00Z` creates an **18:00** local event. This is the original
  behaviour and stays the default, because some adopters store local wall time
  with a nominal `Z` suffix.

Omitting `timezone` when your dates really are UTC silently shifts every event
by the zone's offset, so set it whenever your source stores real instants.

### Network events (one session, several groups)

A Meetup **Pro network** cross-posts the same session to every group in the
network. List the extra groups in `groups`, and give each its own host — groups
in a network almost always have different organizers:

```json
{
  "meetup": {
    "groupUrlname": "chicago-c-cpp-users-group",
    "venues": { "online": "online" },
    "groups": ["cpp-serbia", "CPPTORONTO"],
    "groupTimezones": {
      "chicago-c-cpp-users-group": "America/Chicago",
      "cpp-serbia": "Europe/Belgrade",
      "CPPTORONTO": "America/Toronto"
    },
    "hosts": { "Rob Douglas": 13296813, "Alex Smith": 256192100, "Jordan Lee": 274644230 },
    "groupHosts": {
      "chicago-c-cpp-users-group": ["Rob Douglas"],
      "cpp-serbia": ["Alex Smith"],
      "CPPTORONTO": ["Jordan Lee"]
    }
  }
}
```

`groupUrlname` is always the first target, then `groups` in order, de-duplicated
case-insensitively (Meetup urlnames are case-insensitive, and a network may
report `CPPTORONTO` where your config says `cpptoronto`).

> **Every group gets its own timezone, and this is not a style preference.**
> Meetup has no single "event time": `startDateTime` is wall time in the
> *receiving group's* own zone, with no offset accepted. Send one group's wall
> time to every group and you create a **different instant in each** — a session at
> 16:00Z becomes 11:00 in Chicago and also 11:00 in Belgrade, seven hours apart.
>
> So when a run targets more than one group and `timezone` is set, `timezone` is
> not applied to the groups. Each uses its `groupTimezones` entry, and a group
> without one has its timezone **looked up from Meetup** before any draft is
> created:
>
> ```
> [info] Using Meetup's timezone for cpp-serbia: Europe/Belgrade (pin it with meetup.groupTimezones)
> ```
>
> If any lookup fails, the run stops before creating anything and names the
> groups to pin. A `--dry-run` makes no API calls, so it cannot look anything up:
> it needs a `groupTimezones` entry for every group it targets, and fails with a
> message saying so otherwise. `coopkit-meetup list-groups` prints the map to paste:
>
> ```bash
> bunx coopkit-meetup list-groups
> ```
>
> A run that targets one group (no `--groups`, or `--groups cpp-serbia`) uses that
> group's `groupTimezones` entry if it has one, else `timezone`, as before. Without
> `timezone` nothing is looked up: a group with no `groupTimezones` entry keeps the
> wall-time reading described in [Timezones](#timezones--read-this-if-your-dates-are-utc).

```bash
# every group in the config
bunx coopkit-meetup create-from-json --groups all --dry-run event.json

# just some of them
bunx coopkit-meetup create-from-json --groups "cpp-serbia,CPPTORONTO" event.json
```

Without `--groups` only `groupUrlname` is used, and `--output` keeps its
original single-event shape — so existing setups are unaffected. With
`--groups`, `--output` gets a per-group breakdown instead:

```json
{
  "status": "partial",
  "groups": [
    { "groupUrlname": "chicago-c-cpp-users-group", "ok": true, "status": "created", "eventId": "1234", "eventUrl": "https://…", "photoAttached": false, "speakerPhotoAttached": false },
    { "groupUrlname": "cpp-serbia", "ok": false, "error": "createEvent returned no event. …" }
  ]
}
```

Groups are processed **sequentially**, and one group failing does not stop the
others — every outcome is reported so you can retry just the failures. The exit
code is 1 if any group failed. There is **no rollback**: drafts already created
stay, so a retry needs the failed groups named explicitly or it will duplicate
the ones that worked.

> **Why not `proNetworkEvents`?** `CreateEventInput` has a `proNetworkEvents`
> input that propagates one event across a network via a saved `filterId`. That
> filter cannot be enumerated through the API, so which groups it would reach is
> unverifiable from code. Naming the groups is explicit, and each draft can be
> reviewed or deleted on its own. Every account member must still have rights in
> each target group — being a Pro network admin is not by itself enough.

### Speaker profiles (Pro only)

Meetup Pro events can carry a speaker profile. It comes from the event's
`speaker`, and because non-Pro groups reject the field it is **opt-in**:

```json
"speakerDetails": true
```

or, when only some of your groups are in the network:

```json
"speakerDetails": ["chicago-c-cpp-users-group", "cpp-serbia"]
```

The mapping from `NormalizedEvent.speaker`:

| Meetup field | Source | Notes |
| --- | --- | --- |
| `name` | `speaker.name` | Required by the API. |
| `description` | `speaker.bioMarkdown` | Required by the API — see below. |
| `socialNetworks` | `speaker.socialUrls` | Classified into Meetup's service enum. |
| `photoId` | `speaker.avatarUrl` | Only with `speakerPhoto`, uploaded after the event is created — see below. |

**A speaker with no bio is skipped, with a warning.** Meetup requires a
non-empty `description`, and sending an empty string would publish a hollow
profile, so `speakerDetails` is omitted entirely rather than half-filled. Give
the speaker a `bioMarkdown` to have it appear.

`socialUrls` are plain URLs — `NormalizedEvent` stays platform-neutral — and get
classified by host into `LINKEDIN`, `TWITTER` (including `x.com`), `INSTAGRAM`,
`FACEBOOK`, `TIKTOK`, `TUMBLR`, `FLICKR`, or `OTHER` for anything else such as a
personal site. Entries that are not URLs are dropped rather than guessed at. The
full URL is kept as the `identifier`: Meetup's name for the field suggests a bare
handle, but the per-service shape is undocumented, and a URL is unambiguous and
lossless for every service including `OTHER`.

#### Speaker photo (opt-in)

`speaker.avatarUrl` is ignored unless you also turn on `speakerPhoto`, which
takes the same forms as `speakerDetails` — `true` for every group, or a list of
group urlnames (case-insensitive):

```json
"speakerDetails": ["chicago-c-cpp-users-group", "cpp-serbia"],
"speakerPhoto": ["cpp-serbia"]
```

Without it nothing changes from v0.3.0: no upload, no `editEvent`, no extra
log lines, and `speakerPhotoAttached` is `false`. In the library API the same
switch is `includeSpeakerPhoto: true` on `createMeetupDraft` (or on a group
passed to `createMeetupDrafts`), next to `includeSpeaker`; there is no config
to check there, so without `includeSpeaker` it simply does nothing.

The photo belongs to the speaker profile, so **every group `speakerPhoto` covers
must also have `speakerDetails`**. A config where one does not is refused when
it is loaded, rather than silently uploading nothing; `"speakerPhoto": true`
covers `groupUrlname` and every group in `groups`. Even when both are on, a
speaker with no bio sends no profile and therefore no photo.

**The speaker photo goes on after the event exists.** `photoId` must name a
photo the group already holds, and the API has no speaker photo upload, so
`createEvent` sends the profile without one. Once the draft is created, the
headshot at `avatarUrl` is uploaded as one of the event's photos
(`EVENT_PHOTO`, not set as the featured photo, so the banner stays) and the
profile is sent again through `editEvent`, now with `photoId`. A dry run makes
no calls and just says it would upload the photo.

A photo problem never costs you the draft or the rest of the profile: any
failure, from a dead `avatarUrl` to Meetup rejecting the `photoId`, is logged
as a warning and the draft is kept as created. Whether it worked is reported
as `speakerPhotoAttached`, next to `photoAttached`, in the `createMeetupDraft`
result and in `--output` (always `false` without `speakerPhoto`). Nothing is
rolled back: if the upload worked but `editEvent` did not, the headshot is left
among the event's photos.

`avatarUrl` must be an http(s) URL. It is downloaded the same way as the
featured `imageUrl`, which takes only URLs, so a filesystem path (which
`NormalizedSpeaker` also allows) is skipped with a warning.

> **Not yet verified against the live API.** The upload is the same one the
> featured photo uses, but attaching it through `speakerDetails.photoId` on
> `editEvent` has not been exercised on a real Pro event. `speakerPhotoAttached:
> true` means Meetup accepted the edit, not that anyone has seen the photo on
> the page, so check the first draft by hand.

### Hosts

`eventHosts` takes Meetup **member IDs**, and the account must be a member of
the group. Name them in `hosts` and select them per run with `--host`, or set
`defaultHosts` to apply the same host every time. When no host is resolved the
key is omitted from the payload entirely and Meetup falls back to the creating
organizer.

To find a member ID, query the group's organizer:

```graphql
query { groupByUrlname(urlname: "your-group-slug") { organizer { id name } } }
```

Discover venue IDs:

```bash
bunx coopkit-meetup list-venues --group your-group-slug
```

> **Tip — registering a new venue.** Meetup only exposes venues already linked to your group. As a group organizer, start creating an event in the Meetup web UI, fill in the venue's address, save as draft, then re-run `list-venues`. The new venue appears. Delete the throwaway draft afterward.

## CLI

### File-per-event

```bash
bunx coopkit-meetup create --dry-run events/2026-04-29-My-Event.md
bunx coopkit-meetup create events/2026-04-29-My-Event.md

# override the configured defaultHosts for one run
bunx coopkit-meetup create --host "Rob Douglas" events/2026-04-29-My-Event.md
```

Idempotent. Writes `event_url` + `event_id` back into the file's frontmatter on success.

### From a JSON input (manual / form-driven)

```bash
echo '{
  "id": "2026-05-09-daniel-lemire",
  "title": "Algorithms for Modern Processor Architectures",
  "date": "2026-05-09T16:00:00Z",
  "duration": "PT1H30M",
  "venueKey": "online",
  "description": "..."
}' | bunx coopkit-meetup create-from-json --config coopkit.config.json

# or from a file
bunx coopkit-meetup create-from-json --config coopkit.config.json event.json
```

No writeback — the JSON path is for one-shot creation. Adopters who need bookkeeping write their own callback via the library API.

### List venues

```bash
bunx coopkit-meetup list-venues
```

### List groups (timezones)

```bash
bunx coopkit-meetup list-groups
```

Prints each configured group's name and the timezone Meetup holds for it, plus a
ready-to-paste `groupTimezones` map. A group that cannot be read is listed with
`(unknown)` and warned about rather than aborting the listing.

## Library API

```ts
import { createMeetupDraft, createMeetupDraftFromFile } from "@coopkit/meetup";

// File-per-event source — reads frontmatter, writes back on success
await createMeetupDraftFromFile({
  eventFile: "events/2026-04-29-My-Event.md",
  groupUrlname: "your-group-slug",
  venues: { "Venue, City, cc": 12345678 },
});

// Custom source — you construct the NormalizedEvent any way you want
await createMeetupDraft({
  event: {
    id: "2026-05-09-daniel-lemire",
    title: "Algorithms for Modern Processor Architectures",
    date: new Date("2026-05-09T16:00:00Z"),
    duration: "PT1H30M",
    venueKey: "online",
    description: "...",
  },
  groupUrlname: "your-group-slug",
  venues: { online: 23456789 },
  // Persist the IDs back to wherever your source-of-truth lives
  onCreated: async ({ event, result }) => {
    appendToEventsYaml(event.id, {
      meetup_url: result.eventUrl,
      meetup_id: result.eventId,
    });
  },
});
```

Lower-level building blocks (`createMeetupClient`, `buildCreateEventPayload`, `resolveVenueId`, `listVenues`) are also exported.

## GitHub Actions

Two reusable workflows live in the [coopkit repo](https://github.com/cppserbia/coopkit):

### `_meetup-event-draft.yml` — PR-label-triggered (file-per-event)

For cppserbia-style repos where each event is a markdown file and a PR adds one event at a time.

```yaml
# .github/workflows/meetup-event-draft.yml
name: Meetup Event Draft
on:
  pull_request:
    types: [labeled]
jobs:
  draft:
    if: github.event.label.name == 'meetup-event'
    uses: cppserbia/coopkit/.github/workflows/_meetup-event-draft.yml@main
    secrets: inherit
```

### `_meetup-event-manual.yml` — manually-triggered with a form

For repos whose events don't live in structured files. A maintainer opens the Actions tab, fills in title + date + venue + …, hits Run. No event extractor needed.

```yaml
# .github/workflows/meetup-manual.yml
name: Create Meetup Event (manual)
on:
  workflow_dispatch:
    inputs:
      title: { required: true, type: string, description: Event title }
      date:  { required: true, type: string, description: "ISO datetime (UTC), e.g. 2026-05-09T16:00:00Z" }
      duration: { required: false, type: string, default: "PT1H30M", description: ISO-8601 duration }
      venue-key: { required: false, type: string, default: online, description: Must exist in coopkit.config.json venue map }
      description: { required: false, type: string, description: "Event description (Markdown OK)" }
      image-url: { required: false, type: string, description: Featured photo URL }
      dry-run: { required: false, type: boolean, default: false }

jobs:
  draft:
    uses: cppserbia/coopkit/.github/workflows/_meetup-event-manual.yml@main
    with:
      title: ${{ inputs.title }}
      date: ${{ inputs.date }}
      duration: ${{ inputs.duration }}
      venue-key: ${{ inputs.venue-key }}
      description: ${{ inputs.description }}
      image-url: ${{ inputs.image-url }}
      dry-run: ${{ inputs.dry-run }}
    secrets: inherit
```

Required secrets for both: `MEETUP_CLIENT_KEY`, `MEETUP_MEMBER_ID`, `MEETUP_SIGNING_KEY_ID`, `MEETUP_PRIVATE_KEY` (PEM contents).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `createEvent` returns 403 / `insufficient_scope` | OAuth client is missing the `event_management` scope. |
| `Unknown venue "…"` | Add the venue to `coopkit.config.json#meetup.venues`. |
| `Meetup group not found for urlname "…"` | `groupUrlname` is wrong or the member isn't an organizer of the group. |
| `OAuth2 token exchange failed: 401` | Private key, signing-key ID, or client key mismatch. |
| `createGroupEventPhoto returned no photo or uploadUrl` | Meetup rejected the image. Check the URL is reachable and < ~10 MB. |
| `Dry run cannot look up the timezone of "…"` | A multi-group dry run with `timezone` set needs a `groupTimezones` entry for every targeted group. Paste them from `list-groups`, or run without `--dry-run`. |
| `No drafts were created: could not get the timezone of "…"` | Meetup did not return those groups' timezones (check the urlname and the account's access), so nothing was created. Pin them in `groupTimezones`. |
| `meetup.speakerPhoto covers "…", which meetup.speakerDetails does not` | `speakerPhoto` names a group with no speaker profile to attach the photo to. Add the group to `speakerDetails`, or leave it out of `speakerPhoto`. |
| `[warn] Speaker photo failed, keeping the speaker profile without it` | The draft and profile were created; only the headshot is missing. The rest of the message says which step failed. Add the photo in Meetup's editor. |
