import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "./apply.mjs";
import {
  AUTH_PATHS,
  LIMITS,
  NEVER_LIMITED_PATHS,
  PHASE_CUSTOM,
  PHASE_RATE_LIMIT,
  REF_PREFIX,
  TIERS,
  buildDefinition,
  limitFor,
} from "./definition.mjs";

const HOSTS = { public: ["donors.example.org"], staff: ["staff.donors.example.org"], website: ["example.com"], atm: ["atm.example.org"] };

const allRateLimitRules = () => TIERS.flatMap((tier) => buildDefinition({ tier, hosts: HOSTS }).phases[PHASE_RATE_LIMIT]);

function balanced(expression) {
  let depth = 0;
  let inString = false;
  for (const ch of expression) {
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "(" || ch === "{") depth++;
    if (ch === ")" || ch === "}") depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && !inString;
}

test("expressions are balanced and name only fields the tier offers", () => {
  for (const tier of TIERS) {
    const { phases } = buildDefinition({ tier, hosts: HOSTS });
    for (const rule of Object.values(phases).flat()) {
      assert.ok(rule.expression.length > 0 && rule.expression.length < 4096, rule.ref);
      assert.ok(balanced(rule.expression), `${tier} ${rule.ref}`);
      assert.ok(rule.ref.startsWith(REF_PREFIX));
    }
    for (const rule of phases[PHASE_RATE_LIMIT]) {
      if (tier === "free") assert.ok(!rule.expression.includes("http.host"), "free has no host field");
      if (tier !== "business" && tier !== "enterprise") {
        assert.ok(!rule.expression.includes("http.request.method"), `${tier} has no method field`);
      }
    }
  }
});

test("every rate limiting expression excludes the Stripe webhook and health paths", () => {
  const rules = allRateLimitRules();
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    for (const path of NEVER_LIMITED_PATHS) {
      assert.ok(rule.expression.includes(`"${path}"`), `${rule.ref} must exclude ${path}`);
    }
    assert.match(rule.expression, /and not lower\(http\.request\.uri\.path\) in \{/);
  }
  assert.ok(NEVER_LIMITED_PATHS.includes("/api/donor/stripe/webhook"));
  assert.ok(NEVER_LIMITED_PATHS.includes("/health/live") && NEVER_LIMITED_PATHS.includes("/health/ready"));
  for (const path of NEVER_LIMITED_PATHS) assert.ok(!AUTH_PATHS.includes(path));
});

test("thresholds match the documented table", () => {
  assert.deepEqual(limitFor("donor-auth", "pro"), { period: 60, requests: 30, timeout: 600 });
  assert.deepEqual(limitFor("donor-auth", "free"), { period: 10, requests: 5, timeout: 10 });
  assert.deepEqual(limitFor("donor-visitor", "business"), { period: 60, requests: 240, timeout: 60 });
  assert.equal(limitFor("donor-visitor", "free"), null);
  assert.deepEqual(limitFor("donor-pages", "enterprise"), { period: 60, requests: 1200, timeout: 0 });
  assert.deepEqual(limitFor("website-forms", "business"), { period: 600, requests: 25, timeout: 3600 });
  assert.deepEqual(limitFor("atm-ledger", "business"), { period: 60, requests: 120, timeout: 60 });
  assert.deepEqual(Object.keys(LIMITS).sort(), ["atm-ledger", "donor-auth", "donor-pages", "donor-visitor", "website-forms"]);
});

test("edge limits sit above the app limits", () => {
  const perMinute = (name, tier) => {
    const l = limitFor(name, tier);
    return (l.requests * 60) / l.period;
  };
  assert.ok(perMinute("donor-auth", "pro") > 10);
  assert.ok(perMinute("donor-auth", "free") > 10 - 1);
  assert.ok(perMinute("donor-visitor", "pro") > 60);
  assert.ok(perMinute("atm-ledger", "pro") >= 60);
  assert.ok(perMinute("website-forms", "pro") > 10 / 60);
});

test("rule budgets and periods stay within the plan", () => {
  const budget = { free: 1, pro: 2, business: 5, enterprise: 100 };
  const longestPeriod = { free: 10, pro: 60, business: 600, enterprise: 65535 };
  for (const tier of TIERS) {
    const { phases, skipped } = buildDefinition({ tier, hosts: HOSTS });
    const rules = phases[PHASE_RATE_LIMIT];
    assert.ok(rules.length <= budget[tier], tier);
    for (const r of rules) {
      assert.ok(r.ratelimit.period <= longestPeriod[tier], `${tier} ${r.ref}`);
      if (tier === "free") assert.equal(r.ratelimit.mitigation_timeout, 10);
      if (r.action !== "block") assert.equal(r.ratelimit.mitigation_timeout, 0);
    }
    if (tier === "free") {
      assert.deepEqual(rules.map((r) => r.ref), [`${REF_PREFIX}donor-auth`]);
      assert.ok(skipped.length > 0);
    }
  }
});

test("pro keeps auth and visitor, business adds the rest", () => {
  const refs = (tier) => buildDefinition({ tier, hosts: HOSTS }).phases[PHASE_RATE_LIMIT].map((r) => r.ref.slice(REF_PREFIX.length));
  assert.deepEqual(refs("pro"), ["donor-auth", "donor-visitor"]);
  assert.deepEqual(refs("business"), ["donor-auth", "donor-visitor", "website-forms", "atm-ledger", "donor-pages"]);
});

test("rules only exist for the hosts given", () => {
  const { phases } = buildDefinition({ tier: "business", hosts: { website: ["example.com"] } });
  assert.deepEqual(phases[PHASE_RATE_LIMIT].map((r) => r.ref), [`${REF_PREFIX}website-forms`]);
  assert.deepEqual(phases[PHASE_CUSTOM], []);
  assert.throws(() => buildDefinition({ tier: "pro", hosts: {} }), /no hosts/);
  assert.throws(() => buildDefinition({ tier: "gold", hosts: HOSTS }), /unknown tier/);
});

test("the Stripe skip rule runs in the custom phase and never blocks", () => {
  const { phases } = buildDefinition({ tier: "pro", hosts: HOSTS });
  const [skip, block] = phases[PHASE_CUSTOM];
  assert.equal(skip.action, "skip");
  assert.ok(skip.expression.includes("/api/donor/stripe/webhook"));
  assert.ok(skip.action_parameters.phases.includes("http_ratelimit"));
  assert.equal(block.action, "block");
  assert.ok(block.expression.includes('"/staff"'));
  assert.ok(!block.expression.includes("webhook"));
});

function mockApi(state) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = init.method;
    const phase = /phases\/([^/]+)\/entrypoint/.exec(url)[1];
    calls.push({ method, phase, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (method === "GET") {
      if (!state[phase]) return { status: 404, json: async () => ({ success: false, errors: [{ code: 10003, message: "not found" }] }) };
      return { status: 200, json: async () => ({ success: true, result: { id: "rs", rules: state[phase] } }) };
    }
    state[phase] = JSON.parse(init.body).rules;
    return { status: 200, json: async () => ({ success: true, result: { rules: state[phase] } }) };
  };
  return { fetchImpl, calls };
}

const ENV = {
  EDGE_PUBLIC_HOSTS: "donors.example.org",
  EDGE_STAFF_HOSTS: "staff.donors.example.org",
  CLOUDFLARE_ZONE_ID: "zone1",
  CLOUDFLARE_API_CREDENTIAL: "secret-value",
};

const quiet = () => {
  const lines = [];
  return { out: (l) => lines.push(l), lines };
};

test("apply refuses without --apply and makes no request", async () => {
  const { fetchImpl, calls } = mockApi({});
  await assert.rejects(run(["apply", "--tier", "pro"], { env: ENV, fetchImpl, out: () => {} }), /--apply/);
  assert.equal(calls.length, 0);
});

test("plan reads the zone and writes nothing", async () => {
  const { fetchImpl, calls } = mockApi({});
  const { out, lines } = quiet();
  await run(["plan", "--tier", "pro"], { env: ENV, fetchImpl, out });
  assert.deepEqual(calls.map((c) => c.method), ["GET", "GET"]);
  assert.ok(lines.some((l) => l.includes("add") && l.includes("dad-edge-donor-auth")));
  assert.ok(lines.includes("dry run: nothing changed"));
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/zones/zone1/rulesets/phases/http_ratelimit/entrypoint");
  assert.equal(calls[0].headers.Authorization, "Bearer secret-value");
});

test("apply sends the managed rules and keeps unmanaged ones", async () => {
  const unmanagedRate = { id: "u1", ref: "owner-rule", description: "owner", expression: "true", action: "log", enabled: true, last_updated: "x", version: "1" };
  const staleManaged = { id: "m1", ref: `${REF_PREFIX}retired`, description: "[dad-edge] old", expression: "false", action: "block", enabled: true };
  const state = { [PHASE_RATE_LIMIT]: [unmanagedRate, staleManaged] };
  const { fetchImpl, calls } = mockApi(state);
  await run(["apply", "--apply", "--tier", "pro"], { env: ENV, fetchImpl, out: () => {} });
  const put = calls.find((c) => c.method === "PUT" && c.phase === PHASE_RATE_LIMIT);
  const refs = put.body.rules.map((r) => r.ref);
  assert.deepEqual(refs, [`${REF_PREFIX}donor-auth`, `${REF_PREFIX}donor-visitor`, "owner-rule"]);
  const kept = put.body.rules.at(-1);
  assert.equal(kept.id, "u1");
  assert.ok(!("last_updated" in kept) && !("version" in kept));
  const expected = buildDefinition({ tier: "pro", hosts: { public: ["donors.example.org"], staff: ["staff.donors.example.org"] } });
  assert.deepEqual(put.body.rules.slice(0, 2), expected.phases[PHASE_RATE_LIMIT]);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 2);
});

test("apply twice is idempotent even when the API adds defaults", async () => {
  const state = {};
  const first = mockApi(state);
  await run(["apply", "--apply", "--tier", "pro"], { env: ENV, fetchImpl: first.fetchImpl, out: () => {} });
  for (const rules of Object.values(state)) {
    for (const r of rules) {
      r.id = "assigned";
      r.last_updated = "now";
      if (r.ratelimit) r.ratelimit = { ...r.ratelimit, counting_expression: "" };
    }
  }
  const second = mockApi(state);
  const { out, lines } = quiet();
  await run(["apply", "--apply", "--tier", "pro"], { env: ENV, fetchImpl: second.fetchImpl, out });
  assert.equal(second.calls.filter((c) => c.method === "PUT").length, 0);
  assert.ok(!lines.some((l) => /^\s+(add|change|remove)\s/.test(l)));
});

test("a changed threshold is reported and rewritten", async () => {
  const state = {};
  await run(["apply", "--apply", "--tier", "pro"], { env: ENV, fetchImpl: mockApi(state).fetchImpl, out: () => {} });
  state[PHASE_RATE_LIMIT][0].ratelimit.requests_per_period = 999;
  const { fetchImpl, calls } = mockApi(state);
  const { out, lines } = quiet();
  await run(["apply", "--apply", "--tier", "pro"], { env: ENV, fetchImpl, out });
  assert.ok(lines.some((l) => /change\s+dad-edge-donor-auth/.test(l)));
  assert.equal(state[PHASE_RATE_LIMIT][0].ratelimit.requests_per_period, 30);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
});

test("--disable deploys a rule switched off and --remove-all removes ours only", async () => {
  const state = { [PHASE_RATE_LIMIT]: [{ ref: "owner-rule", expression: "true", action: "log", enabled: true }] };
  const { fetchImpl } = mockApi(state);
  await run(["apply", "--apply", "--tier", "pro", "--disable", `${REF_PREFIX}donor-visitor`], { env: ENV, fetchImpl, out: () => {} });
  const visitor = state[PHASE_RATE_LIMIT].find((r) => r.ref === `${REF_PREFIX}donor-visitor`);
  assert.equal(visitor.enabled, false);
  await run(["apply", "--apply", "--tier", "pro", "--remove-all"], { env: { CLOUDFLARE_ZONE_ID: "zone1", CLOUDFLARE_API_CREDENTIAL: "x" }, fetchImpl, out: () => {} });
  assert.deepEqual(state[PHASE_RATE_LIMIT].map((r) => r.ref), ["owner-rule"]);
  assert.deepEqual(state[PHASE_CUSTOM], []);
});

test("the credential can come from a file and is required", async () => {
  const { fetchImpl, calls } = mockApi({});
  const env = { EDGE_PUBLIC_HOSTS: "donors.example.org", CLOUDFLARE_ZONE_ID: "z", CLOUDFLARE_API_CREDENTIAL_FILE: "/cred" };
  await run(["plan", "--tier", "pro"], { env, fetchImpl, readFile: () => "from-file\n", out: () => {} });
  assert.equal(calls[0].headers.Authorization, "Bearer from-file");
  await assert.rejects(run(["plan", "--tier", "pro"], { env: { ...env, CLOUDFLARE_API_CREDENTIAL_FILE: "" }, fetchImpl, out: () => {} }), /CLOUDFLARE_API_CREDENTIAL/);
});

test("render needs no network or credential", async () => {
  const { out, lines } = quiet();
  const { phases } = await run(["render", "--tier", "free"], { env: { EDGE_PUBLIC_HOSTS: "a.org" }, fetchImpl: () => assert.fail("no network"), out });
  assert.equal(phases[PHASE_RATE_LIMIT].length, 1);
  assert.ok(lines.some((l) => l.includes("dad-edge-donor-auth")));
});

test("API errors surface with the Cloudflare message", async () => {
  const fetchImpl = async () => ({ status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }) });
  await assert.rejects(run(["plan", "--tier", "pro"], { env: ENV, fetchImpl, out: () => {} }), /HTTP 403.*Authentication error/);
});
