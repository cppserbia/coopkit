#!/usr/bin/env node
import fs from "node:fs";
import type { NormalizedEvent } from "@coopkit/core";
import { defineCommand, runMain } from "citty";
import { loadMeetupConfig } from "./config.js";
import { createMeetupDraft, createMeetupDraftFromFile } from "./create-event.js";
import { formatVenueKey, listVenues } from "./list-venues.js";
import { loadEnvFile } from "./load-env.js";

/**
 * Write the run result as a JSON object to `outputPath` (if given) so callers
 * — notably GitHub Actions — can capture the created event's id/url. Keeps the
 * package free of any Actions-specific coupling: it just emits JSON.
 */
function writeResultFile(
  outputPath: string | undefined,
  result: { status: string; eventId?: string; eventUrl?: string; photoAttached?: boolean }
): void {
  if (!outputPath) return;
  const payload =
    result.status === "created"
      ? {
          status: result.status,
          eventId: result.eventId ?? "",
          eventUrl: result.eventUrl ?? "",
          photoAttached: result.photoAttached ?? false,
        }
      : { status: result.status };
  fs.writeFileSync(outputPath, `${JSON.stringify(payload)}\n`);
}

const createCmd = defineCommand({
  meta: {
    name: "create",
    description:
      "Create a Meetup.com Draft event from an event markdown file (file-per-event source).",
  },
  args: {
    eventFile: {
      type: "positional",
      required: true,
      description: "Path to the event markdown file.",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the CreateEventInput payload without calling the Meetup API.",
    },
    config: {
      type: "string",
      description: "Path to coopkit.config.json (default: ./coopkit.config.json).",
    },
    output: {
      type: "string",
      description:
        "Write the result as JSON to this file (status, eventId, eventUrl, photoAttached).",
    },
  },
  async run({ args }) {
    loadEnvFile();
    const config = loadMeetupConfig(args.config);
    const result = await createMeetupDraftFromFile({
      eventFile: args.eventFile,
      groupUrlname: config.groupUrlname,
      venues: config.venues,
      dryRun: Boolean(args["dry-run"]),
    });
    writeResultFile(args.output, result);
    if (result.status === "skipped") {
      process.exit(0);
    }
  },
});

function readStdin(): string {
  return fs.readFileSync(0, "utf8");
}

function parseNormalizedEvent(json: string): NormalizedEvent {
  const obj = JSON.parse(json) as Partial<NormalizedEvent> & { date?: string | Date };
  if (!obj.id || typeof obj.id !== "string") {
    throw new Error("JSON input is missing required `id` field (string).");
  }
  if (!obj.title || typeof obj.title !== "string") {
    throw new Error("JSON input is missing required `title` field (string).");
  }
  if (!obj.date) {
    throw new Error("JSON input is missing required `date` field (ISO string or Date).");
  }
  const date = obj.date instanceof Date ? obj.date : new Date(obj.date);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`JSON input has invalid \`date\`: ${String(obj.date)}`);
  }
  return { ...obj, date } as NormalizedEvent;
}

const createFromJsonCmd = defineCommand({
  meta: {
    name: "create-from-json",
    description:
      "Create a Meetup.com Draft event from a NormalizedEvent JSON object on stdin or in a file.",
  },
  args: {
    file: {
      type: "positional",
      required: false,
      description: "Path to a JSON file. If omitted, reads JSON from stdin.",
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the CreateEventInput payload without calling the Meetup API.",
    },
    config: {
      type: "string",
      description: "Path to coopkit.config.json (default: ./coopkit.config.json).",
    },
    output: {
      type: "string",
      description:
        "Write the result as JSON to this file (status, eventId, eventUrl, photoAttached).",
    },
  },
  async run({ args }) {
    loadEnvFile();
    const config = loadMeetupConfig(args.config);
    const raw = args.file ? fs.readFileSync(args.file, "utf8") : readStdin();
    const event = parseNormalizedEvent(raw);
    const result = await createMeetupDraft({
      event,
      groupUrlname: config.groupUrlname,
      venues: config.venues,
      dryRun: Boolean(args["dry-run"]),
    });
    writeResultFile(args.output, result);
  },
});

const listVenuesCmd = defineCommand({
  meta: {
    name: "list-venues",
    description: "List Meetup venues for a group and print a ready-to-paste JSON map.",
  },
  args: {
    group: {
      type: "string",
      description:
        "Group urlname. Defaults to MEETUP_GROUP_URLNAME env var or meetup.groupUrlname in config.",
    },
    config: {
      type: "string",
      description: "Path to coopkit.config.json (used to read default groupUrlname).",
    },
  },
  async run({ args }) {
    loadEnvFile();
    let groupUrlname: string | undefined = args.group ?? process.env.MEETUP_GROUP_URLNAME;
    if (!groupUrlname) {
      try {
        groupUrlname = loadMeetupConfig(args.config).groupUrlname;
      } catch {
        // Fall through to error below.
      }
    }
    if (!groupUrlname) {
      console.error(
        "Missing group urlname. Pass --group <slug>, set MEETUP_GROUP_URLNAME, " +
          "or create coopkit.config.json with meetup.groupUrlname."
      );
      process.exit(1);
    }

    const venues = await listVenues({ groupUrlname });

    if (venues.length === 0) {
      console.error(`No venues found for group "${groupUrlname}".`);
      return;
    }

    console.error(`Found ${venues.length} venue(s) for group "${groupUrlname}".\n`);
    console.error("--- Raw venue details ---");
    for (const v of venues) {
      console.error(`  id=${v.id}`);
      console.error(`    name:    ${v.name ?? "(none)"}`);
      console.error(`    address: ${v.address ?? "(none)"}`);
      console.error(`    city:    ${v.city ?? "(none)"} / state: ${v.state ?? "(none)"}`);
      console.error(`    country: ${v.country ?? "(none)"}`);
      console.error("");
    }

    console.error("--- Suggested entries for coopkit.config.json `meetup.venues` ---");
    console.error(
      "Keys must match the EXACT strings in your event frontmatter 'venues:' arrays.\n"
    );
    const map: Record<string, number> = {};
    for (const v of venues) {
      map[formatVenueKey(v)] = Number(v.id);
    }
    console.log(JSON.stringify(map, null, 2));
  },
});

const main = defineCommand({
  meta: {
    name: "coopkit-meetup",
    description: "Meetup.com automation for coopkit.",
  },
  subCommands: {
    create: createCmd,
    "create-from-json": createFromJsonCmd,
    "list-venues": listVenuesCmd,
  },
});

runMain(main).then(() => process.exit(0));
