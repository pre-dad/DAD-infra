export const REF_PREFIX = "dad-edge-";
export const DESCRIPTION_PREFIX = "[dad-edge] ";

export const PHASE_RATE_LIMIT = "http_ratelimit";
export const PHASE_CUSTOM = "http_request_firewall_custom";

export const TIERS = ["free", "pro", "business", "enterprise"];

const RATE_LIMIT_RULES = { free: 1, pro: 2, business: 5, enterprise: 100 };

export const NEVER_LIMITED_PATHS = [
  "/api/donor/stripe/webhook",
  "/health/live",
  "/health/ready",
  "/api/health/live",
  "/api/health/ready",
  "/api/health.php",
];

export const AUTH_PATHS = [
  "/api/donor/login",
  "/api/donor/claim",
  "/api/donor/email-change/confirm",
  "/api/donor/passkeys/sign-in",
  "/api/donor/passkeys/sign-in/options",
  "/api/donor/phone/sign-in",
  "/api/donor/phone/sign-in/options",
  "/api/donor/partner/sign-in",
  "/api/donor/partner/accept-invite",
  "/api/donor/staff/sign-in",
  "/api/donor/staff/sign-in/options",
  "/api/donor/staff/activate",
  "/api/donor/staff/activate/options",
];

export const VISITOR_PATHS = [
  "/api/donor/checkouts",
  "/api/donor/public/partner-apply",
  "/api/donor/partner/applications",
];

export const VISITOR_PREFIXES = ["/api/donor/referrals/", "/api/donor/company/"];

export const WEBSITE_FORM_PATH = "/api/submit.php";

const STAFF_PREFIXES = ["/staff", "/api/donor/staff"];

const TOO_MANY = JSON.stringify({ detail: "Too many requests" });

/**
 * Per-IP edge limits, a little above the layer behind each (API per task, nginx per
 * client). Free only offers a 10 second counting period, so its thresholds are the
 * per-minute figure divided by six.
 */
export const LIMITS = {
  "donor-auth": {
    free: { period: 10, requests: 5, timeout: 10 },
    pro: { period: 60, requests: 30, timeout: 600 },
  },
  "donor-visitor": {
    pro: { period: 60, requests: 240, timeout: 60 },
  },
  "website-forms": {
    free: { period: 10, requests: 5, timeout: 10 },
    pro: { period: 60, requests: 15, timeout: 600 },
    business: { period: 600, requests: 25, timeout: 3600 },
    enterprise: { period: 3600, requests: 15, timeout: 3600 },
  },
  "atm-ledger": {
    free: { period: 10, requests: 20, timeout: 10 },
    pro: { period: 60, requests: 120, timeout: 60 },
  },
  "donor-pages": {
    business: { period: 60, requests: 1200, timeout: 0 },
  },
};

const tierIndex = (tier) => TIERS.indexOf(tier);

export function limitFor(name, tier) {
  const byTier = LIMITS[name];
  for (let i = tierIndex(tier); i >= 0; i--) if (byTier[TIERS[i]]) return byTier[TIERS[i]];
  return null;
}

const quote = (s) => JSON.stringify(s);
const set = (items) => `{${items.map(quote).join(" ")}}`;

function hostClause(hosts, tier) {
  if (tier === "free" || hosts.length === 0) return null;
  return hosts.length === 1
    ? `http.host eq ${quote(hosts[0])}`
    : `http.host in ${set(hosts)}`;
}

function methodClause(method, tier) {
  return tierIndex(tier) >= tierIndex("business") ? `http.request.method eq ${quote(method)}` : null;
}

const excluded = () => `not lower(http.request.uri.path) in ${set(NEVER_LIMITED_PATHS)}`;

const and = (clauses) => clauses.filter(Boolean).join(" and ");

function pathMatch({ exact = [], prefixes = [], suffix = null, suffixPrefix = null }) {
  const parts = [];
  if (exact.length) parts.push(`http.request.uri.path in ${set(exact)}`);
  for (const p of prefixes) parts.push(`starts_with(http.request.uri.path, ${quote(p)})`);
  if (suffixPrefix) {
    parts.push(
      `(starts_with(http.request.uri.path, ${quote(suffixPrefix)}) and ends_with(http.request.uri.path, ${quote(suffix)}))`,
    );
  }
  return parts.length === 1 ? parts[0] : `(${parts.join(" or ")})`;
}

function rateLimitRule(name, description, expression, tier, action = "block") {
  const limit = limitFor(name, tier);
  if (!limit) return { name, rule: null };
  const rule = {
    ref: `${REF_PREFIX}${name}`,
    description: `${DESCRIPTION_PREFIX}${description}`,
    expression,
    action,
    ratelimit: {
      characteristics: ["cf.colo.id", "ip.src"],
      period: limit.period,
      requests_per_period: limit.requests,
      mitigation_timeout: limit.timeout,
    },
    enabled: true,
  };
  if (action === "block") {
    rule.action_parameters = {
      response: { status_code: 429, content_type: "application/json", content: TOO_MANY },
    };
  }
  return { name, rule };
}

/**
 * Builds the rules this repo manages. Rate limiting rules come back in priority order
 * and are cut at the plan's rule budget; what does not fit is reported in `skipped`.
 */
export function buildDefinition({ tier, hosts = {} }) {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}" (expected ${TIERS.join(", ")})`);
  const { public: publicHosts = [], staff: staffHosts = [], website = [], atm = [] } = hosts;
  if (publicHosts.length + staffHosts.length + website.length + atm.length === 0) {
    throw new Error("no hosts given: set at least one of the EDGE_*_HOSTS variables");
  }
  const donorHosts = [...publicHosts, ...staffHosts];
  const candidates = [];

  if (donorHosts.length) {
    candidates.push(
      rateLimitRule(
        "donor-auth",
        "Sign-in, claim and activation: per-IP brute-force cap above the API's 10/min",
        and([
          hostClause(donorHosts, tier),
          methodClause("POST", tier),
          pathMatch({
            exact: AUTH_PATHS,
            suffixPrefix: "/api/donor/oidc/",
            suffix: "/sign-in",
          }),
          excluded(),
        ]),
        tier,
      ),
    );
  }
  if (publicHosts.length) {
    candidates.push(
      rateLimitRule(
        "donor-visitor",
        "Checkout, referral, company and partner application: per-IP cap above the API's 60/min",
        and([
          hostClause(publicHosts, tier),
          methodClause("POST", tier),
          pathMatch({ exact: VISITOR_PATHS, prefixes: VISITOR_PREFIXES }),
          excluded(),
        ]),
        tier,
      ),
    );
  }
  if (website.length) {
    candidates.push(
      rateLimitRule(
        "website-forms",
        "Website form posts: per-IP cap above the app's 10 per hour",
        and([
          hostClause(website, tier),
          methodClause("POST", tier),
          `http.request.uri.path eq ${quote(WEBSITE_FORM_PATH)}`,
          excluded(),
        ]),
        tier,
      ),
    );
  }
  if (atm.length) {
    candidates.push(
      rateLimitRule(
        "atm-ledger",
        "ATM ledger Worker: per-IP cap above the Worker's global 60/min bucket",
        and([hostClause(atm, tier), excluded()]),
        tier,
      ),
    );
  }
  if (publicHosts.length) {
    candidates.push(
      rateLimitRule(
        "donor-pages",
        "Pages: challenge a client rendering more than 1,200 uncached pages a minute",
        and([
          hostClause(publicHosts, tier),
          `not starts_with(http.request.uri.path, "/api/")`,
          `not starts_with(http.request.uri.path, "/_next/static/")`,
          excluded(),
        ]),
        tier,
        "managed_challenge",
      ),
    );
  }

  const wanted = candidates.filter((c) => c.rule);
  const budget = RATE_LIMIT_RULES[tier];
  const rateLimit = wanted.slice(0, budget).map((c) => c.rule);
  const skipped = [
    ...candidates.filter((c) => !c.rule).map((c) => `${REF_PREFIX}${c.name}: not offered on ${tier}`),
    ...wanted.slice(budget).map((c) => `${REF_PREFIX}${c.name}: over the ${budget}-rule ${tier} budget`),
  ];

  const custom = [];
  if (publicHosts.length) {
    const host = hostClause(publicHosts, "pro");
    custom.push(
      {
        ref: `${REF_PREFIX}skip-stripe-webhook`,
        description: `${DESCRIPTION_PREFIX}Stripe webhook: skip rate limiting, managed rules and bot checks`,
        expression: `${host} and http.request.method eq "POST" and http.request.uri.path eq "/api/donor/stripe/webhook"`,
        action: "skip",
        action_parameters: {
          ruleset: "current",
          phases: ["http_ratelimit", "http_request_firewall_managed", "http_request_sbfm"],
          products: ["bic", "hot", "rateLimit", "securityLevel", "uaBlock", "waf", "zoneLockdown"],
        },
        logging: { enabled: true },
        enabled: true,
      },
      {
        ref: `${REF_PREFIX}block-staff-on-public-host`,
        description: `${DESCRIPTION_PREFIX}Back office is served on the staff host only`,
        expression: `${host} and (${STAFF_PREFIXES.map((p) => `starts_with(lower(http.request.uri.path), ${quote(p)})`).join(" or ")})`,
        action: "block",
        enabled: true,
      },
    );
  }

  return {
    tier,
    phases: { [PHASE_RATE_LIMIT]: rateLimit, [PHASE_CUSTOM]: custom },
    skipped,
  };
}
