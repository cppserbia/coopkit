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
bun add @coopkit/meetup
# or: npm install @coopkit/meetup
```

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
    "venues": {
      "Venue Name, City, cc": 12345678,
      "online": 23456789
    }
  }
}
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
