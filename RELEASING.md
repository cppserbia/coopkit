# Releasing

Both packages (`@coopkit/core`, `@coopkit/meetup`) are versioned together and
published to npm by the [`Publish`](.github/workflows/publish.yml) workflow.

## One-time setup

1. Create an **npm automation token** (npmjs.com → Access Tokens → Granular/Automation, with publish rights to the `@coopkit` scope).
2. Add it as the repo secret **`NPM_TOKEN`** (Settings → Secrets and variables → Actions).
3. The `@coopkit` org/scope must exist on npm and the token's account must be a member with publish rights.

## Cutting a release

1. Bump the `version` field in **both** `packages/core/package.json` and `packages/meetup/package.json` to the same value (e.g. `0.2.0`). Commit to `main`.
2. Tag the commit and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The `Publish` workflow runs on the `v*` tag: it builds, typechecks, tests, verifies both `package.json` versions equal the tag, then publishes **`@coopkit/core` first, then `@coopkit/meetup`**.

That order matters because `@coopkit/meetup` depends on `@coopkit/core`. Bun rewrites the `workspace:*` dependency to the concrete version (`0.2.0`) at publish time — npm cannot do this, which is why publishing uses `bun publish`.

## Dry run

Use the **Run workflow** button (workflow_dispatch) on the Publish workflow with `dry_run` checked (the default). It packs and validates both packages with `bun publish --dry-run` — no registry writes, no token required.

## Behavior notes

- **Idempotent per package.** If a package's current version is already on the registry, it's skipped. So you can bump only `@coopkit/meetup`, re-tag, and the workflow republishes meetup while skipping the unchanged core.
- **Prereleases.** A version containing a hyphen (e.g. `0.2.0-rc.1`) publishes under the npm `next` dist-tag instead of `latest`.
- **Provenance.** Real publishes pass `--provenance` (requires the public repo + `id-token: write`, both configured). If you ever publish from a private repo, drop that flag.
- **Gate.** The workflow won't publish unless build + typecheck + test all pass.

## Re-publishing the same version

npm does not allow overwriting a published version. To ship a fix, bump the version and tag again.
