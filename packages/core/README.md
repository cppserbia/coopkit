# @coopkit/core

Shared types for the [coopkit](https://github.com/cppserbia/coopkit) toolkit. Two shapes live here:

- **`NormalizedEvent`** — the platform-neutral event description that all coopkit automation packages (`@coopkit/meetup`, `@coopkit/banners`, `@coopkit/social`) consume. Adopters with any source-of-truth (markdown files, README bullets, YAML data, a CMS) produce these.
- **`EventFrontmatter`** — the YAML frontmatter shape used by adopters whose source-of-truth is one markdown file per event.

Plus a `frontmatterToNormalizedEvent()` helper for the common file-per-event case.

## Install

```bash
bun add @coopkit/core
# or: npm install @coopkit/core
```

## Two paths into the automation packages

### File-per-event source (cppserbia pattern)

```ts
import matter from "gray-matter";
import { frontmatterToNormalizedEvent } from "@coopkit/core";

const raw = readFileSync("events/2026-05-09-my-event.md", "utf8");
const { data, content } = matter(raw);
const event = frontmatterToNormalizedEvent("2026-05-09-my-event", data, content);
// → pass `event` to any @coopkit/* package
```

Or use `@coopkit/meetup`'s `createMeetupDraftFromFile()` which does this for you.

### Custom source (GlobalCpp pattern: bullet list in README)

```ts
import type { NormalizedEvent } from "@coopkit/core";

function extractEvents(): NormalizedEvent[] {
  const readme = readFileSync("README.md", "utf8");
  return parseBulletLines(readme).map((line) => ({
    id: `${line.date}-${slug(line.speaker)}`,
    date: new Date(`${line.date}T16:00:00Z`),  // weekly 11am CT
    title: line.title,
    speaker: {
      name: line.speaker,
      avatarUrl: resolvePresenterImage(line.speakerLink),
    },
    duration: "PT1H30M",
    raw: { sourceLineNumber: line.lineNo },
  }));
}
```

## The `NormalizedEvent` contract

```ts
interface NormalizedEvent {
  id: string;                 // stable identifier (your choice of shape)
  date: Date;
  title: string;
  description?: string;       // plain text or Markdown
  duration?: string;          // ISO-8601 (e.g. "PT2H")
  venueKey?: string;          // resolves against your venue map
  speaker?: { name: string; avatarUrl?: string; bioMarkdown?: string };
  imageUrl?: string;          // banner URL
  recordingUrl?: string;
  registrationUrl?: string;
  raw?: unknown;              // your adapter-specific original payload
}
```

Packages only read what they need. `raw` survives round-trips so you can write back to your source in `onCreated`-style callbacks.
