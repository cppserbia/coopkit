# Reusable workflows

> GitHub requires reusable workflows to live under `.github/workflows/` of the source repo. The actual files are in [`../.github/workflows/`](../.github/workflows/) — this file documents how to call them.

## `_meetup-event-draft.yml` — PR-label-triggered (file-per-event)

Creates a Meetup Draft event from a PR labeled `meetup-event` (label name is configurable). Best for repos where events live as individual markdown files. Reads `coopkit.config.json` in the caller's repo. Writes `event_url` + `event_id` back into the event file.

### Minimum caller workflow

```yaml
# .github/workflows/meetup-event-draft.yml
name: Meetup Event Draft
on:
  pull_request:
    types: [labeled]

jobs:
  draft:
    uses: cppserbia/coopkit/.github/workflows/_meetup-event-draft.yml@main
    secrets:
      MEETUP_CLIENT_KEY: ${{ secrets.MEETUP_CLIENT_KEY }}
      MEETUP_MEMBER_ID: ${{ secrets.MEETUP_MEMBER_ID }}
      MEETUP_SIGNING_KEY_ID: ${{ secrets.MEETUP_SIGNING_KEY_ID }}
      MEETUP_PRIVATE_KEY: ${{ secrets.MEETUP_PRIVATE_KEY }}
```

### Inputs

| Input | Default | Purpose |
|---|---|---|
| `label` | `meetup-event` | PR label that triggers a run. |
| `events-glob` | `^events/.*\.md$` | POSIX ERE matching candidate event files. |
| `events-exclude` | `^events/_` | POSIX ERE excluding files. |
| `config-path` | `coopkit.config.json` | Path to the config file. |
| `package-version` | `latest` | Version of `@coopkit/meetup`. |
| `bun-version` | `1.3.13` | Bun version. |
| `bot-name` | `coopkit-bot` | `git user.name` for writeback. |
| `bot-email` | `41898282+github-actions[bot]@users.noreply.github.com` | `git user.email` for writeback. |
| `commit-message` | `chore(meetup): add draft event URL` | Writeback commit subject. |

### Security

- Same-repo PRs only (fork PRs cannot push back via `GITHUB_TOKEN`).
- Author association is `OWNER`, `MEMBER`, or `COLLABORATOR`.

These checks are non-configurable; loosening them would allow random PRs to call your Meetup API.

---

## `_meetup-event-manual.yml` — manually-triggered (form input)

Creates a Meetup Draft event from form fields filled in by a maintainer in the Actions tab. **No source-of-truth coupling** — the caller's repo only needs `coopkit.config.json` with the venue map. Best for repos that don't store events in structured files, or for one-off events that don't fit the normal pipeline.

### Caller workflow

```yaml
# .github/workflows/meetup-manual.yml
name: Create Meetup Event (manual)
on:
  workflow_dispatch:
    inputs:
      title:       { required: true,  type: string, description: "Event title" }
      date:        { required: true,  type: string, description: "ISO datetime UTC (e.g. 2026-05-09T16:00:00Z)" }
      duration:    { required: false, type: string, default: PT1H30M }
      venue-key:   { required: false, type: string, default: online, description: "Must exist in coopkit.config.json" }
      description: { required: false, type: string, description: "Markdown OK" }
      image-url:   { required: false, type: string }
      dry-run:     { required: false, type: boolean, default: false }

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
    secrets:
      MEETUP_CLIENT_KEY: ${{ secrets.MEETUP_CLIENT_KEY }}
      MEETUP_MEMBER_ID: ${{ secrets.MEETUP_MEMBER_ID }}
      MEETUP_SIGNING_KEY_ID: ${{ secrets.MEETUP_SIGNING_KEY_ID }}
      MEETUP_PRIVATE_KEY: ${{ secrets.MEETUP_PRIVATE_KEY }}
```

### Inputs

| Input | Required | Default | Purpose |
|---|---|---|---|
| `title` | yes | — | Event title. |
| `date` | yes | — | ISO datetime in UTC. |
| `duration` | no | `PT2H` | ISO-8601 duration (e.g. `PT1H30M`). |
| `venue-key` | yes | — | Key into `coopkit.config.json#meetup.venues`. |
| `description` | no | `""` | Markdown event description. |
| `image-url` | no | `""` | Public URL of a featured photo. |
| `id` | no | _auto_ | Event identifier. Default is `YYYY-MM-DD-slugified-title`. |
| `dry-run` | no | `false` | Print payload, skip API. |
| `config-path` | no | `coopkit.config.json` | |
| `package-version` | no | `latest` | |
| `bun-version` | no | `1.3.13` | |

### Why is there no writeback?

The manual flow is one-shot: the maintainer typed the fields, they don't need them written anywhere. If you need bookkeeping (e.g. to populate an `events.yml`), use the library API (`createMeetupDraft` with an `onCreated` callback) from your own script.
