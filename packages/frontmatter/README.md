# @coopkit/frontmatter

The shared event-frontmatter type contract for the [coopkit](https://github.com/cppserbia/coopkit) toolkit.

This package exports a single `EventFrontmatter` TypeScript interface that the other `@coopkit/*` packages consume. It has zero runtime dependencies — the type describes the YAML frontmatter of event Markdown files.

## Install

```bash
bun add @coopkit/frontmatter
# or: npm install @coopkit/frontmatter
```

## Usage

```ts
import type { EventFrontmatter } from "@coopkit/frontmatter";

const fm: EventFrontmatter = {
  title: "C++ Beer Wednesday",
  date: new Date("2026-04-29T18:00:00"),
  duration: "PT2H",
  venues: ["Docker Brewery & Beer Garden, Beograd, rs"],
  status: "ACTIVE",
};
```

Adopter repos are free to add extra fields — coopkit packages only consume what they need.
