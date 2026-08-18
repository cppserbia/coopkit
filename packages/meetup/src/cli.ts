#!/usr/bin/env node
import fs from "node:fs";
import type { NormalizedEvent } from "@coopkit/core";
import { defineCommand, runMain } from "citty";
import {
  type GroupTarget,
  type MeetupConfig,
  loadMeetupConfig,
  resolveGroupTargets,
} from "./config.js";
import {
  createMeetupDraft,
  createMeetupDraftFromFile,
  createMeetupDrafts,
  createMeetupDraftsFromFile,
} from "./create-event.js";
import { listGroups } from "./list-groups.js";
import { formatVenueKey, listVenues } from "./list-venues.js";
import { loadEnvFile } from "./load-env.js";

/**
 * A per-group run's outcome, loose enough for both multi-group entry points:
 * `create-from-json` never skips, while the file path can report
 * `{status: "skipped", reason}` for a group already recorded in the file.
 */
type MultiGroupResult = {
  results: Array<
    { groupUrlname: string } & (
      | { ok: true; result: SingleResult & { reason?: string } }
      | { ok: false; error: string }
    )
  >;
};

/**
 * Collapse per-group outcomes into one status: "partial" if any group failed,
 * otherwise whatever the groups agree on ("dry-run", "created", "skipped").
 * Reporting a dry run as "created" would be a lie a caller might act on.
 */
function aggregateStatus(result: MultiGroupResult): string {
  if (result.results.some((r) => !r.ok)) return "partial";
  const statuses = new Set(result.results.map((r) => (r.ok ? r.result.status : "failed")));
  return statuses.size === 1 ? ([...statuses][0] ?? "created") : "mixed";
}

type SingleResult = {
  status: string;
  eventId?: string;
  eventUrl?: string;
  photoAttached?: boolean;
};

function summarizeSingle(result: SingleResult) {
  return result.status === "created"
    ? {
        status: result.status,
        eventId: result.eventId ?? "",
        eventUrl: result.eventUrl ?? "",
        photoAttached: result.photoAttached ?? false,
      }
    : { status: result.status };
}

/**
 * Write the run result as a JSON object to `outputPath` (if given) so callers
 * — notably GitHub Actions — can capture the created event's id/url. Keeps the
 * package free of any Actions-specific coupling: it just emits JSON.
 */
function writeResultFile(
  outputPath: string | undefined,
  result: SingleResult | MultiGroupResult
): void {
  if (!outputPath) return;

  // A multi-group run has no single id/url to report, so emit the per-group
  // breakdown instead of flattening it to one (arbitrary) event.
  const payload =
    "results" in result
      ? {
          status: aggregateStatus(result),
          groups: result.results.map((r) =>
            r.ok
              ? {
                  groupUrlname: r.groupUrlname,
                  ok: true,
                  ...summarizeSingle(r.result),
                  // Only the per-group shape carries a skip reason; the
                  // single-group payload stays exactly as it was.
                  ...(r.result.reason !== undefined ? { reason: r.result.reason } : {}),
                }
              : { groupUrlname: r.groupUrlname, ok: false, error: r.error }
          ),
        }
      : summarizeSingle(result);

  fs.writeFileSync(outputPath, `${JSON.stringify(payload)}\n`);
}

/**
 * Split a comma-separated `--host` / `--groups` value into trimmed names.
 * Returns `undefined` — not `[]` — for an all-empty value such as `","`: an
 * empty array is truthy and would silently read as "every group".
 */
function parseCsvArg(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return parts.length > 0 ? parts : undefined;
}

const GROUPS_ARG_DESCRIPTION =
  'Group urlname(s) to create the event in, comma-separated, or "all" for every group in the config. Defaults to meetup.groupUrlname only.';

/**
 * Resolve which groups a run targets, shared by both create commands.
 *
 * Without `--groups` this selects `meetup.groupUrlname` alone and reports
 * `multiGroup: false`, which keeps the original single-group code path — same
 * frontmatter write-back, same `--output` shape.
 */
function resolveTargets(
  config: MeetupConfig,
  args: { host?: string; groups?: string }
): { targets: GroupTarget[]; multiGroup: boolean } {
  const hostNames = parseCsvArg(args.host);
  const requested = parseCsvArg(args.groups);
  const multiGroup = requested !== undefined;
  const all = requested?.length === 1 && requested[0]?.toLowerCase() === "all";
  const only = multiGroup ? (all ? undefined : requested) : [config.groupUrlname];
  const targets = resolveGroupTargets(config, {
    ...(only !== undefined ? { only } : {}),
    ...(hostNames !== undefined ? { hostNames } : {}),
  });
  return { targets, multiGroup };
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
    host: {
      type: "string",
      description:
        "Host name(s) from meetup.hosts, comma-separated. Defaults to meetup.defaultHosts.",
    },
    groups: {
      type: "string",
      description: GROUPS_ARG_DESCRIPTION,
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
    const { targets, multiGroup } = resolveTargets(config, args);

    // Single-group runs keep the original path: scalar event_url/event_id
    // write-back and the flat --output shape.
    if (!multiGroup) {
      const [target] = targets;
      if (!target) throw new Error("No group resolved from the config.");
      const result = await createMeetupDraftFromFile({
        eventFile: args.eventFile,
        groupUrlname: target.urlname,
        venues: config.venues,
        ...((target.timezone ?? config.timezone) !== undefined
          ? { timezone: (target.timezone ?? config.timezone) as string }
          : {}),
        ...(target.hosts.length > 0 ? { hosts: target.hosts } : {}),
        includeSpeaker: target.includeSpeaker,
        dryRun: Boolean(args["dry-run"]),
      });
      writeResultFile(args.output, result);
      return;
    }

    // `targets` carry a per-group timezone; config.timezone stays only as the
    // fallback for a single-group config that names no groupTimezones.
    const result = await createMeetupDraftsFromFile({
      eventFile: args.eventFile,
      groups: targets,
      // Always the config's primary group, never whichever group --groups
      // happens to name first: the scalars must keep pointing at one group.
      primaryGroup: config.groupUrlname,
      venues: config.venues,
      ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
      dryRun: Boolean(args["dry-run"]),
    });
    writeResultFile(args.output, result);
    if (result.results.some((r) => !r.ok)) process.exitCode = 1;
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
    host: {
      type: "string",
      description:
        "Host name(s) from meetup.hosts, comma-separated. Defaults to meetup.defaultHosts.",
    },
    groups: {
      type: "string",
      description: GROUPS_ARG_DESCRIPTION,
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
    const { targets, multiGroup } = resolveTargets(config, args);

    // Single-group runs keep returning the bare result, so existing callers
    // parsing --output see no change; --groups opts into the per-group report.
    if (!multiGroup) {
      const target = targets[0];
      if (!target) throw new Error("No group resolved from the config.");
      const result = await createMeetupDraft({
        event,
        groupUrlname: target.urlname,
        venues: config.venues,
        ...((target.timezone ?? config.timezone) !== undefined
          ? { timezone: (target.timezone ?? config.timezone) as string }
          : {}),
        ...(target.hosts.length > 0 ? { hosts: target.hosts } : {}),
        includeSpeaker: target.includeSpeaker,
        dryRun: Boolean(args["dry-run"]),
      });
      writeResultFile(args.output, result);
      return;
    }

    // `targets` carry a per-group timezone; config.timezone stays only as the
    // fallback for a single-group config that names no groupTimezones.
    const result = await createMeetupDrafts({
      event,
      groups: targets,
      venues: config.venues,
      ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
      dryRun: Boolean(args["dry-run"]),
    });
    writeResultFile(args.output, result);
    if (result.results.some((r) => !r.ok)) process.exitCode = 1;
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

const listGroupsCmd = defineCommand({
  meta: {
    name: "list-groups",
    description:
      "Show each configured group's timezone and print a ready-to-paste groupTimezones map.",
  },
  args: {
    config: {
      type: "string",
      description: "Path to coopkit.config.json (default: ./coopkit.config.json).",
    },
  },
  async run({ args }) {
    loadEnvFile();
    const config = loadMeetupConfig(args.config);
    const urlnames = [config.groupUrlname, ...(config.groups ?? [])];
    const groups = await listGroups({ urlnames });

    for (const g of groups) {
      console.error(`  ${g.urlname}  ${g.name ?? "(unreadable)"}  ${g.timezone ?? "(unknown)"}`);
    }

    const unknown = groups.filter((g) => !g.timezone).map((g) => g.urlname);
    if (unknown.length > 0) {
      console.error(
        `\n[warn] No timezone for: ${unknown.join(", ")}. Check the urlname and that the account can read the group.`
      );
    }

    console.error("\n--- Suggested `meetup.groupTimezones` for coopkit.config.json ---\n");
    const map: Record<string, string> = {};
    for (const g of groups) if (g.timezone) map[g.urlname] = g.timezone;
    console.log(JSON.stringify({ groupTimezones: map }, null, 2));
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
    "list-groups": listGroupsCmd,
  },
});

// Exit explicitly: the HTTP client uses global fetch, whose keep-alive sockets
// keep the process alive for seconds after the last call, which reads as a hang
// on CI. No argument, so a process.exitCode set by a handler (a partial
// multi-group failure) survives instead of being overwritten with 0.
runMain(main).then(() => process.exit());
