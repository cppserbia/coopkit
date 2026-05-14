# @coopkit/meetup

> Create Meetup.com Draft events from Markdown files in a Git repo.

Library + CLI for creating Meetup.com events from a PR that adds an event markdown file. Part of the [coopkit](https://github.com/cppserbia/coopkit) toolkit.

When a Pull Request adds an event Markdown file (with the expected YAML frontmatter), the CLI calls Meetup's GraphQL API to create a **Draft** event, optionally uploads a featured photo, and writes `event_url` + `event_id` back into the frontmatter. Idempotent — re-running on an already-created event is a no-op.

## Install

```bash
bun add @coopkit/meetup
# or: npm install @coopkit/meetup
```

## One-time Meetup OAuth setup

1. Create a Meetup OAuth app at <https://www.meetup.com/api/oauth/create/>. Grant the **`event_management`** scope; `createEvent` 403s without it.
2. In the app settings, **JWT Signing Keys → Generate Key**. Save the private-key PEM file and note the **Key ID**.
3. Find your Meetup **member ID** (in your profile URL). The account must be an **organizer** of the target group.

Set these environment variables (or put them in a `.env` next to your config):

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
      "Venue Name, City, cc": 12345678
    }
  }
}
```

Discover your group's venue IDs with:

```bash
bunx coopkit-meetup list-venues --group your-group-slug
```

The command prints a ready-to-paste JSON map. Keys must match the **exact** strings in your event frontmatter `venues:` arrays.

> **Tip — registering a brand-new venue.** Meetup only exposes venues already linked to your group. To add a new one: as a group organizer, start creating an event in the Meetup web UI, fill in the venue's address, **save as draft** (don't publish), then re-run `list-venues`. The venue is now registered. Delete the throwaway draft afterward.

## Event frontmatter contract

```yaml
---
title: My Event
date: 2026-04-29T18:00:00
duration: PT2H              # ISO-8601 duration
venues:
  - "Venue Name, City, cc"  # must match a key in coopkit.config.json
imageUrl: https://...       # optional; uploaded as featured photo
event_url: ""               # written back after creation
event_id: <Meetup.com Event ID>  # placeholder; replaced after creation
---

# My Event

Body becomes the Meetup event description (the leading H1 is stripped).
```

## CLI

```bash
# Dry-run: print the GraphQL input, no API call
bunx coopkit-meetup create --dry-run events/2026-04-29-My-Event.md

# Real run
bunx coopkit-meetup create events/2026-04-29-My-Event.md

# Discover venue IDs for your group
bunx coopkit-meetup list-venues
```

## Library API

```ts
import { createMeetupEvent } from "@coopkit/meetup";

const result = await createMeetupEvent({
  eventFile: "events/2026-04-29-My-Event.md",
  groupUrlname: "your-group-slug",
  venues: { "Venue, City, cc": 12345678 },
});

// result.status: "skipped" | "dry-run" | "created"
```

Lower-level building blocks (`createMeetupClient`, `buildCreateEventPayload`, `resolveVenueId`, `listVenues`) are exported from the package root if you want to compose them differently.

## GitHub Actions

The reusable workflow at [`workflows/meetup-event-draft.yml`](https://github.com/cppserbia/coopkit/blob/main/workflows/meetup-event-draft.yml) in the coopkit monorepo wires this up to a PR-label trigger. Reference it from your repo:

```yaml
# .github/workflows/meetup-event-draft.yml
name: Meetup Event Draft
on:
  pull_request:
    types: [labeled]
jobs:
  draft:
    if: github.event.label.name == 'meetup-event'
    uses: cppserbia/coopkit/.github/workflows/meetup-event-draft.yml@main
    secrets: inherit
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `createEvent` returns 403 / `insufficient_scope` | OAuth client is missing the `event_management` scope. |
| `Unknown venue "…"` | Add the venue to `coopkit.config.json#meetup.venues`. |
| `Meetup group not found for urlname "…"` | `groupUrlname` is wrong or the member isn't an organizer of the group. |
| `OAuth2 token exchange failed: 401` | Private key, signing-key ID, or client key mismatch. |
| `createGroupEventPhoto returned no photo or uploadUrl` | Image fetch succeeded but Meetup rejected it. Check the URL is reachable and the image is < ~10 MB. |
