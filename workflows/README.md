# Reusable workflows

> GitHub requires reusable workflows to live under `.github/workflows/` of the source repo. The actual files are in [`../.github/workflows/`](../.github/workflows/) — this file documents how to call them.

## `_meetup-event-draft.yml`

Creates a Meetup.com Draft event from a PR labeled `meetup-event` (label name is configurable). Reads `coopkit.config.json` in the caller's repo for the group urlname and venue map. Pre-requisite: `@coopkit/meetup` is published to npm (the workflow invokes it via `bunx`).

### Minimum caller workflow

```yaml
# .github/workflows/meetup-event-draft.yml in your events repo
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

### Full input set

| Input | Default | Purpose |
|---|---|---|
| `label` | `meetup-event` | PR label that triggers a run. |
| `events-glob` | `^events/.*\.md$` | POSIX ERE matching candidate event files (against `gh pr diff --name-only`). |
| `events-exclude` | `^events/_` | POSIX ERE excluding files from `events-glob`. |
| `config-path` | `coopkit.config.json` | Path to the config file in the caller's repo. |
| `package-version` | `latest` | Version of `@coopkit/meetup` to invoke. |
| `bun-version` | `1.3.13` | Bun version installed on the runner. |
| `bot-name` | `coopkit-bot` | `git user.name` for the writeback commit. |
| `bot-email` | `41898282+github-actions[bot]@users.noreply.github.com` | `git user.email` for the writeback commit. |
| `commit-message` | `chore(meetup): add draft event URL` | Commit subject for the writeback. |

### Required secrets

`MEETUP_CLIENT_KEY`, `MEETUP_MEMBER_ID`, `MEETUP_SIGNING_KEY_ID`, `MEETUP_PRIVATE_KEY` (PEM contents — the workflow writes them to a tmpfile).

### Security

The workflow gates execution on:

- Same-repo PRs only (fork PRs cannot push back via `GITHUB_TOKEN`).
- Author association is `OWNER`, `MEMBER`, or `COLLABORATOR`.

These checks are non-configurable; loosening them would allow random PRs to call your Meetup API.
