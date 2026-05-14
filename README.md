# coopkit

> Open-source toolkit for community event automation. Bring your events; the kit handles the busywork.

`coopkit` is a monorepo of small, composable packages and reusable GitHub Actions that automate the work of running a community meetup, user group, or conference. It treats **a Git repo of Markdown files as the source of truth for events** — no database, no SaaS lock-in — and layers automation on top of pull requests:

- **`@coopkit/meetup`** — create Meetup.com Draft events from a PR
- **`@coopkit/banners`** _(coming in Phase 3)_ — generate multi-format event banners from SVG templates
- **`@coopkit/social`** _(coming in Phase 2)_ — draft localized social-media posts with an LLM and publish on merge
- **`@coopkit/frontmatter`** — the shared event-frontmatter type contract

Each package is independently versioned and consumable on its own. The reusable GitHub workflows under [`workflows/`](./workflows) wrap them into ready-to-call CI jobs.

## Status

Phase 1 (Meetup) is the first extracted subsystem. See [the plan](#roadmap) for what comes next.

## Why "coopkit"?

Cooperative — as in worker co-ops, platform co-ops, the cooperative movement. Building community tools is cooperative work. The toolkit ships under the MIT license; community organizers are welcome to fork, adapt, and contribute back.

## Usage

Each package has its own README. The fastest path for a new adopter is:

1. Drop a `coopkit.config.json` at the root of your events repo describing your Meetup group, venue map, etc.
2. Reference one of the [reusable workflows](./workflows) from your repo's `.github/workflows/`.
3. Open a PR that adds an event Markdown file with the expected frontmatter.

See [`packages/meetup/README.md`](./packages/meetup/README.md) for the Meetup-specific setup.

## Roadmap

- **Phase 1** — `@coopkit/meetup` + reusable workflow _(in progress)_
- **Phase 2** — `@coopkit/social` with multi-language (locale-list configurable; default monoglot)
- **Phase 3** — `@coopkit/banners` with a documented SVG template contract

## Development

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun install
bun test        # via turbo, all packages
bun run typecheck
bun run lint
```

## License

MIT
