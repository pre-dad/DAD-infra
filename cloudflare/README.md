# Cloudflare edge rules

Rate limits and two custom firewall rules for the DAD hostnames, declared in
[`definition.mjs`](definition.mjs) and applied with [`apply.mjs`](apply.mjs) through the
Cloudflare Rulesets API. No Terraform and no dependencies: Node 20+ and its built-in
`fetch`. Nothing here runs from CI against Cloudflare; the zone owner applies it.

## Why

The DAD-Main API limits requests in memory, per task, so every task the service scales to
multiplies the effective limit. nginx adds a per-client backstop per ingress task, and
the ATM ledger Worker has one global bucket checked before authentication. Cloudflare
counts per client IP across all of them. Each edge limit sits a little above the layer
behind it, so the app's own limit (with its exact `Retry-After`) stays the one a
legitimate client meets first, and the edge caps the aggregate. Thresholds mirror
[DAD-Main `docs/edge.md`](https://github.com/pre-dad/DAD-Main/blob/dev/docs/edge.md).

## Rules

Paths come from `apps/donor-api/internal/httpapi` and `deploy/nginx` in DAD-Main. Counting
is per client IP (and Cloudflare data center, which the API requires on every plan except
Enterprise). Blocked requests get `429 {"detail":"Too many requests"}`.

| Ref (`dad-edge-…`) | Host | Paths | Threshold | Action | Why | Plan |
| --- | --- | --- | --- | --- | --- | --- |
| `donor-auth` | public + staff | the sign-in, claim, activation and `/options` endpoints, and `/api/donor/oidc/*/sign-in` | Pro+: 30 / 60 s, block 10 min. Free: 5 / 10 s, block 10 s | block | API allows 10/min per task, nginx 20/min | Free (rule 1) |
| `donor-visitor` | public | `/api/donor/checkouts`, `/public/partner-apply`, `/partner/applications`, `/referrals/*`, `/company/*` | 240 / 60 s, block 1 min | block | API 60/min per task, nginx 120/min | Pro |
| `website-forms` | website | `/api/submit.php` | Free: 5 / 10 s. Pro: 15 / 60 s, block 10 min. Business: 25 / 10 min, block 1 h. Enterprise: 15 / 1 h, block 1 h | block | PHP allows 10 per hour per IP | Free |
| `atm-ledger` | ATM | everything | Free: 20 / 10 s. Pro+: 120 / 60 s, block 1 min | block | Worker bucket is 60/min, global | Free |
| `donor-pages` | public | everything except `/api/*` and `/_next/static/*` | 1,200 / 60 s | managed challenge | flood of uncached renders | Business |
| `skip-stripe-webhook` (custom rules) | public | `POST /api/donor/stripe/webhook` | none | skip rate limiting, managed rules, Super Bot Fight Mode | Stripe retries from shared addresses | Free |
| `block-staff-on-public-host` (custom rules) | public | `/staff*`, `/api/donor/staff*` in any case | none | block | back office is staff-host only | Free |

Every rate limiting expression ends with `not lower(http.request.uri.path) in {…}`
naming the Stripe webhook and the health paths (`/health/live`, `/health/ready`, their
`/api/` forms, and the website's `/api/health.php`), so they are never limited even if
the skip rule is switched off. The website's `unsubscribe.php` is deliberately not
limited: mail providers post one-click unsubscribes from shared addresses.

### Plan tiers

Cloudflare limits what a plan may do ([availability table](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability)),
so `--tier` picks the rules, in the priority order of the table above, up to the plan's
budget:

| Tier | Rate limiting rules | Counting periods | Fields | What you get from the table above |
| --- | --- | --- | --- | --- |
| `free` | 1 | 10 s | path only | `donor-auth` (rules for other hosts are listed as skipped) |
| `pro` | 2 | up to 60 s | + host | `donor-auth`, `donor-visitor` |
| `business` | 5 | up to 10 min | + method | all five; expressions also require `POST` |
| `enterprise` | 100 | up to 65,535 s | + method | all five; website rule counts per hour |

Free expressions have no host clause because the field is not available, so a free zone
should hold only the hostnames you want limited. Pro and Free cannot test the method, so
those rules also count GETs on the same paths. `render` and `plan` print what a tier skips.
If the website, donor site and ATM host sit in different zones, run the script once per
zone with that zone's `--tier`, ID, and hosts.

Before the first run, compare against the zone's existing rules: Cloudflare orders rate
limiting rules by position and managed rules go first here.

## Running it

```sh
export EDGE_PUBLIC_HOSTS=donors.example.org        # comma-separated; set the hosts in this zone
export EDGE_STAFF_HOSTS=staff.donors.example.org
export EDGE_WEBSITE_HOSTS=dynamicaid.org           # optional
export EDGE_ATM_HOSTS=ledger.example.org           # optional, see below
export CLOUDFLARE_ZONE_ID=0123456789abcdef0123456789abcdef
export CLOUDFLARE_API_CREDENTIAL_FILE=$HOME/.cloudflare-credential   # or CLOUDFLARE_API_CREDENTIAL
```

The credential is a Cloudflare API credential with `Zone > Zone WAF > Edit` on the zone.
Put its value in a file readable only by you, or export it in the shell; the script
never prints it.

```sh
node cloudflare/apply.mjs render --tier pro      # print the rules, no network
node cloudflare/apply.mjs plan --tier pro        # read the zone, show the diff, change nothing
node cloudflare/apply.mjs apply --tier pro --apply
```

`apply` without `--apply` refuses. It replaces the zone's entrypoint ruleset for the
`http_ratelimit` and `http_request_firewall_custom` phases (Cloudflare's API replaces the
whole entrypoint), so rules the script does not manage are read back and sent unchanged.
A rule is ours when its `ref` starts with `dad-edge-` or its description with
`[dad-edge] `. Running `apply` again with nothing changed sends nothing. Fields Cloudflare
fills in on its own do not count as drift.

### Rollback

- Re-apply the previous version of `definition.mjs` (`git checkout <sha> -- cloudflare/definition.mjs`).
- Switch a rule off without deleting it: `apply --tier pro --apply --disable dad-edge-donor-visitor`.
- Remove everything this script manages: `apply --tier pro --apply --remove-all`.

Rules are also visible and editable in the dashboard under Security → Security rules.

## Caveats

- **ATM ledger.** The Worker is served from `dad-atm-ledger.cocuyo.workers.dev`, which is not
  in any zone, so no zone rule can reach it. `atm-ledger` applies only once the Worker is
  routed on a custom hostname (set `EDGE_ATM_HOSTS`). Until then its protection is the
  Worker's single global 60/min bucket, which checks before authentication, so anonymous
  traffic can exhaust it for CI. Recommendation for DAD-Main: key the binding on the
  verified principal after authentication and keep an unauthenticated bucket per IP.
- **DAD-website behind Cloudflare.** `dad/api/lib/util.php` `client_ip()` returns
  `REMOTE_ADDR` and ignores forwarding headers on purpose. The repos do not show whether
  `dynamicaid.org` is proxied (its DKIM records are in Cloudflare, and it runs on Lightsail).
  If it is, or ever is, every visitor reaches PHP from a Cloudflare address, so the
  10-per-hour limit becomes one shared bucket per Cloudflare edge address and legitimate
  visitors get 429s. Recommended change for DAD-website, not made here: read
  `CF-Connecting-IP` only when `REMOTE_ADDR` is inside Cloudflare's published ranges
  (<https://www.cloudflare.com/ips-v4>, <https://www.cloudflare.com/ips-v6>), keep the
  /64 reduction for IPv6, and keep ignoring `X-Forwarded-For`; also restrict the origin to
  Cloudflare's ranges so the header cannot be forged. Until then the edge `website-forms`
  rule is safe to apply, because it counts the real client address at Cloudflare.
- **Counting is approximate.** Counters are kept per data center and lag by seconds, so
  the edge caps floods, not exact counts.
- **Bot Fight Mode.** Leave the free Bot Fight Mode off; it cannot be skipped and may
  challenge Stripe deliveries (see DAD-Main `docs/edge.md`).

## Tests

```sh
npm run test:cloudflare
```

Runs `node --test cloudflare/*.test.mjs` with a mocked `fetch`: expression sanity, the webhook and
health exclusions, the threshold table above, plan tiers, request bodies, unmanaged rule
preservation, idempotency, and the refusal without `--apply`.
