#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { planPhase, putRules } from "./cloudflare.mjs";
import { PHASE_CUSTOM, PHASE_RATE_LIMIT, TIERS, buildDefinition } from "./definition.mjs";

const USAGE = `Usage: node cloudflare/apply.mjs <render|plan|apply> --tier <${TIERS.join("|")}> [options]

  render   print the rules this tier gets; no network, no credentials
  plan     read the zone and print what apply would change; changes nothing
  apply    write the rules; refuses to run without --apply

Options:
  --tier <tier>        Cloudflare plan of the zone (required)
  --apply              required for apply
  --disable <refs>     comma-separated refs to deploy switched off
  --remove-all         define no managed rules, so apply removes every one of ours

Environment:
  EDGE_PUBLIC_HOSTS, EDGE_STAFF_HOSTS, EDGE_NATIVE_HOSTS, EDGE_WEBSITE_HOSTS, EDGE_ATM_HOSTS
                       comma-separated hostnames in this zone; set at least one
  CLOUDFLARE_ZONE_ID   the zone to change (plan, apply)
  CLOUDFLARE_API_CREDENTIAL        API credential with Zone WAF Edit, or
  CLOUDFLARE_API_CREDENTIAL_FILE   path to a file holding it`;

class UsageError extends Error {}

const list = (value) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function parseArgs(argv) {
  const args = { command: null, tier: null, apply: false, disable: [], removeAll: false };
  const rest = [...argv];
  const valueOf = (flag) => {
    const value = rest.shift();
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return value;
  };
  while (rest.length) {
    const a = rest.shift();
    if (a === "--apply") args.apply = true;
    else if (a === "--remove-all") args.removeAll = true;
    else if (a === "--tier") args.tier = valueOf(a);
    else if (a === "--disable") args.disable = list(valueOf(a));
    else if (!a.startsWith("--") && args.command === null) args.command = a;
    else throw new UsageError(`unknown argument "${a}"`);
  }
  if (!["render", "plan", "apply"].includes(args.command)) throw new UsageError("expected render, plan or apply");
  if (!args.tier) throw new UsageError("--tier is required");
  if (!TIERS.includes(args.tier)) throw new UsageError(`unknown tier "${args.tier}" (expected ${TIERS.join(", ")})`);
  return args;
}

export function hostsFromEnv(env) {
  return {
    public: list(env.EDGE_PUBLIC_HOSTS),
    staff: list(env.EDGE_STAFF_HOSTS),
    native: list(env.EDGE_NATIVE_HOSTS),
    website: list(env.EDGE_WEBSITE_HOSTS),
    atm: list(env.EDGE_ATM_HOSTS),
  };
}

function credentialFrom(env, readFile) {
  if (env.CLOUDFLARE_API_CREDENTIAL) return env.CLOUDFLARE_API_CREDENTIAL.trim();
  if (env.CLOUDFLARE_API_CREDENTIAL_FILE) return readFile(env.CLOUDFLARE_API_CREDENTIAL_FILE, "utf8").trim();
  throw new Error("set CLOUDFLARE_API_CREDENTIAL or CLOUDFLARE_API_CREDENTIAL_FILE");
}

function describe(planned) {
  const lines = [`${planned.phase}: ${planned.unmanaged} unmanaged rule(s) kept`];
  for (const c of planned.changes) lines.push(`  ${c.kind.padEnd(9)} ${c.ref}`);
  if (planned.changes.length === 0) lines.push("  (no managed rules)");
  return lines.join("\n");
}

export async function run(argv, { env = process.env, fetchImpl = fetch, readFile = readFileSync, out = console.log } = {}) {
  const args = parseArgs(argv);
  if (args.command === "apply" && !args.apply) {
    throw new UsageError("refusing to change the zone: apply needs --apply (use plan for a dry run)");
  }
  const phases = { [PHASE_RATE_LIMIT]: [], [PHASE_CUSTOM]: [] };
  if (!args.removeAll) {
    const definition = buildDefinition({ tier: args.tier, hosts: hostsFromEnv(env) });
    Object.assign(phases, definition.phases);
    for (const skipped of definition.skipped) out(`skipped ${skipped}`);
  }

  const known = new Set(Object.values(phases).flat().map((r) => r.ref));
  const unknown = args.disable.filter((ref) => !known.has(ref));
  if (unknown.length) throw new UsageError(`--disable names no rule this tier defines: ${unknown.join(", ")}`);

  if (args.command === "render") {
    out(JSON.stringify(phases, null, 2));
    return { phases };
  }

  const zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) throw new Error("set CLOUDFLARE_ZONE_ID");
  const credential = credentialFrom(env, readFile);
  // Read and plan every phase before writing any, so a read failure cannot leave one
  // phase applied and the other not.
  const results = [];
  for (const [phase, desired] of Object.entries(phases)) {
    results.push(await planPhase({ fetchImpl, credential, zoneId, phase, desired, disable: args.disable }));
  }
  for (const planned of results) {
    out(describe(planned));
    for (const c of planned.changes.filter((c) => c.kind === "change")) {
      out(`    before: ${JSON.stringify(c.before)}\n    after:  ${JSON.stringify(c.rule)}`);
    }
  }
  if (args.command === "apply") {
    for (const planned of results.filter((p) => p.dirty)) {
      await putRules({ fetchImpl, credential, zoneId, phase: planned.phase, rules: planned.rules });
    }
  }
  out(args.command === "apply" ? "applied" : "dry run: nothing changed");
  return { phases, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`error: ${error.message}${error instanceof UsageError ? `\n\n${USAGE}` : ""}`);
    process.exitCode = 1;
  });
}
