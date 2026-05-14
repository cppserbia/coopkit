#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { loadMeetupConfig } from "./config.js";
import { createMeetupEvent } from "./create-event.js";
import { formatVenueKey, listVenues } from "./list-venues.js";
import { loadEnvFile } from "./load-env.js";

const createCmd = defineCommand({
  meta: {
    name: "create",
    description: "Create a Meetup.com Draft event from an event markdown file.",
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
  },
  async run({ args }) {
    loadEnvFile();
    const config = loadMeetupConfig(args.config);
    const result = await createMeetupEvent({
      eventFile: args.eventFile,
      groupUrlname: config.groupUrlname,
      venues: config.venues,
      dryRun: Boolean(args["dry-run"]),
    });
    if (result.status === "skipped") {
      process.exit(0);
    }
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
    "list-venues": listVenuesCmd,
  },
});

runMain(main).then(() => process.exit(0));
