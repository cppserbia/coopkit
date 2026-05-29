# Releasing

Both packages (`@coopkit/core`, `@coopkit/meetup`) are versioned together and
published to npm by the [`Publish`](.github/workflows/publish.yml) workflow,
using **npm Trusted Publishing** (OIDC) — no long-lived npm token in the repo,
and provenance is attached automatically.

## How publishing works

- The workflow runs the npm CLI with `id-token: write`. npm exchanges a
  short-lived GitHub OIDC token for a publish token — there is no `NPM_TOKEN`
  secret.
- It publishes `@coopkit/core` first, then `@coopkit/meetup`.
- `@coopkit/meetup` declares `"@coopkit/core": "workspace:*"` in source (for
  local dev). npm can't publish the `workspace:` protocol, so the workflow
  rewrites that dep to the concrete release version in the ephemeral checkout
  right before `npm publish`. The committed source keeps `workspace:*`.

> We publish with the **npm CLI** (not `bun publish`) because Trusted Publishing
> is an npm CLI feature (the OIDC token exchange). Bun is still used to build and
> test in the same job.

## One-time setup (per package)

Trusted Publishing is configured on npmjs.com **per package**, and a package
must already exist before you can add a trusted publisher. So there's a
bootstrap for the very first release of each package:

1. **Bootstrap publish (once per package).** Publish `0.1.0` of each package a
   first time using a granular npm token with publish rights — e.g. locally:

   ```bash
   bun run build
   cd packages/core   && npm publish --access public
   cd ../meetup       && npm pkg set dependencies.@coopkit/core=0.1.0 && npm publish --access public
   ```

   (You'll need `npm login` or `NPM_TOKEN` in your shell for this one-time step.)

2. **Configure the trusted publisher.** On npmjs.com, for **each** of
   `@coopkit/core` and `@coopkit/meetup`: package → **Settings → Trusted
   Publishing → Add GitHub Actions publisher**:
   - Organization/owner: `cppserbia`
   - Repository: `coopkit`
   - Workflow filename: `publish.yml`
   - Environment: leave blank (we don't use a GH environment)

3. Done. Every subsequent release is tokenless.

## Cutting a release

1. Bump `version` in **both** `packages/core/package.json` and
   `packages/meetup/package.json` to the same value (e.g. `0.2.0`). Commit to `main`.
2. Tag and push:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The `Publish` workflow builds, typechecks, tests, verifies both versions
   equal the tag, then publishes both packages via Trusted Publishing.

## Dry run

Use **Actions → Publish → Run workflow** with `dry_run` checked (the default).
It runs `npm publish --dry-run` for both packages — no registry writes, no auth,
and it works even before the bootstrap is done.

## Behavior notes

- **Idempotent per package.** A package whose current version is already on the
  registry is skipped — bump only one package, re-tag, and just that one
  republishes.
- **Prereleases.** A version with a hyphen (e.g. `0.2.0-rc.1`) publishes under
  the npm `next` dist-tag instead of `latest`.
- **Provenance** is attached automatically on real (non-dry-run) publishes.
- **Gate.** Nothing publishes unless build + typecheck + test pass.

## Re-publishing the same version

npm does not allow overwriting a published version. To ship a fix, bump the
version and tag again.
