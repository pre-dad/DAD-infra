# DAD-infra — AWS infrastructure design

Status: **accepted; built, not yet deployed** · Owner: Shawn · Last updated: 2026-10-29

A single home for the DAD AWS CDK estate. This document decides the repository's
scope, the account/region model, and the architecture for the two initial
tenants — **DAD-Main** (the application) and **DAD-Quality** (the quality runner) —
with DAD-Quality specified in full because it is the net-new work.

### Naming conventions

- **DAD-Quality** is the repo/product formerly called `atm`. The on-disk folder is
  still `.../DAD/atm` and the tool internals keep the `atm` name (package
  `atm-quality`, the `.atm/` directories, the `npm run atm` CLI). This document uses
  **DAD-Quality** at the repo/product level and **atm/ATM** where it refers to the
  literal tool, CLI, path, or resource prefix (e.g. `atm-evidence-*`).
- **DAAD-website** is the repo formerly called `dad-main-website`. (Spelling "DAAD"
  taken as given — confirm it is intentional and not a typo of the "DAD-" prefix.)

---

## 1. Goals and non-goals

### Goals

1. **Stand up ATM on AWS (primary).** Run ATM acceptance against a pinned
   DAD-Main revision on managed compute, honoring ATM's exit-code contract
   (`0`/`1`/`2`/`3`/`130`), and persist the results durably. This is "Path A"
   from the deployment discussion: an ephemeral, batch-style acceptance runner,
   **not** a hosted public dashboard.
   *Status: built and tested, held and not deployed; findings stay in DAD-Main's Worker
   ledger (§6.5).*
2. **Durable, private evidence + history (baked into A).** Store each run's
   `run.json`, `report.html`, and evidence off the ephemeral runner so results
   survive and can be shared. This was "Path C"; it is a property of A's output
   sink, not separate work.
3. **One home for DAD's AWS IaC.** Consolidate DAD-Main's existing CDK and ATM's
   new CDK into one repo so the account map, region, env-selection pattern, and
   the per-account GitHub OIDC provider are single-sourced.

### Non-goals (explicitly deferred)

- **Hosted, multi-user ATM dashboard ("Path B").** ATM is designed single-operator,
  loopback-only, same-origin + session-token protected; its README says in plain
  terms not to expose it publicly. A shared authenticated dashboard is real future
  work (auth, multi-user, decoupled history) and is out of scope here. The storage
  choices below are made so B is a later addition, not a rewrite.
- **Changing ATM's core storage model.** v1 does not rewrite ATM's local
  `.atm/runs/` filesystem history into a native cloud backend (see §6.4).
- **Deploying anything.** Like DAD-Main's infra, all verification is **offline**
  (`npm run build`, `jest`, `cdk synth` with dummy account/region). No
  `cdk deploy`, no live `aws` calls. The estate is parked until the team is ready
  to incur AWS cost.

---

## 2. Account and region model

From the AWS Organization (SSO access portal):

| Account          | ID             | Role in this repo                                  |
| ---------------- | -------------- | -------------------------------------------------- |
| `audit`          | `832348493351` | Org audit. Not a deploy target here.               |
| `dad-management` | `257291437255` | Org/management. Conceptual owner of shared tooling.|
| `production`     | `216833405626` | `-c env=production` deploy target.                 |
| `sandbox`        | `853377042897` | `-c env=staging` deploy target.                    |

Region is **us-east-2 (Ohio)** for everything, matching DAD-Main.

Environment selection mirrors DAD-Main exactly: `-c env=staging|production`
(default `staging`), account/region resolved from a typed config, with
`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` winning when set so `cdk synth` runs
offline with dummy credentials. DAD-Main's `staging` maps to the **sandbox**
account; the repo keeps the `staging` label for continuity with the existing CDK.

---

## 3. Repository scope — what belongs in DAD-infra

The DAD top-level folder holds five repos. Their cloud footprints differ, so the
infra repo is scoped deliberately rather than "everything DAD."

| Repo         | Cloud footprint                                                                 | In DAD-infra?                         |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------- |
| **DAD-Main** | Full AWS CDK estate: ECS Fargate, RDS + RDS Proxy, SES, NLB, ECR (us-east-2).   | **Yes — anchor tenant.**              |
| **DAD-Quality** (`atm`) | Needs a Docker-capable AWS runner + S3 evidence + DynamoDB ledger (same accts). | **Yes — new tenant.**      |
| **DAAD-website** | Deploys to a **Lightsail** VM via `rsync`/SSH + cron. PHP + SQLite. Not CDK. | **No** (different paradigm; see note).|
| **DAD-iOS**  | Swift client. Consumes the API. Cloud concern is App Store / APNs, not IaC.     | **No.**                               |
| **DAD-Android** | Kotlin/Gradle client. Consumes the API. Cloud concern is Play Store signing. | **No.**                               |

**Decision: DAD-infra owns the AWS CloudFormation/CDK estate — DAD-Main and DAD-Quality.**

- iOS and Android provision no cloud infrastructure; they are API clients whose
  "deployment" is app-store delivery. Folding them in would mix Xcode/Gradle
  signing toolchains into an IaC repo for no benefit.
- The **DAAD-website** is real deployed infrastructure but lives in a different
  paradigm — an imperative `rsync` + cron sync to a hand-managed Lightsail box,
  not declarative CloudFormation. Its deploy scripts stay in the website repo.
  Noted as a **possible future tenant**: if its underlying AWS resources
  (Lightsail instance, DNS, supporting buckets) ever become IaC-managed, the
  *resource definitions* could move here even while content sync stays rsync.

---

## 4. Proposed repository layout

One repo, one shared config/pipeline core, one CDK app per tenant. Deploys are
path-filtered, so a change to one tenant does not deploy the other.

```
DAD-infra/
  packages/
    config/          # shared: account map, region, EnvConfig, getConfig() + offline fallback
    pipeline-iam/    # shared: GitHub OIDC provider (one per account) + per-account deploy roles
  apps/
    dad-main/        # extracted from DAD-Main/infra (lib/, bin/, test/, cdk.json)
    atm/             # NEW: CodeBuild runner, S3 evidence, DynamoDB ledger, triggers
  docs/
    design/          # this document
  .github/
    workflows/       # dad-main-infra.yml: PR synth of both apps, path-filtered deploys
```

Design principles:

- **Single-source the account map and region.** `packages/config` is the one
  place `853377042897` / `216833405626` / `us-east-2` and the `-c env` resolution
  live. Both apps import it. Today these values are duplicated inside
  DAD-Main's `lib/config.ts`; extraction de-duplicates them.
- **One OIDC provider per account.** A GitHub Actions OIDC provider is an
  account-level singleton. DAD-Main's `pipeline-iam-stack.ts` already creates one;
  if ATM created its own in a separate repo they would collide. `packages/pipeline-iam`
  owns the provider once; each app contributes its own scoped deploy roles.
- **App isolation.** Each app is its own CDK app (own `cdk.json`, own stack graph).
  The PR `synth` job is unfiltered and synthesizes both apps, because a required check
  must always report. Deploys are path-filtered (`apps/dad-main/**`, `packages/**`), so
  ATM changes never trigger a DAD-Main deploy. `apps/atm` has no deploy job.

---

## 5. Inherited conventions (from DAD-Main/infra)

DAD-Main's `infra/` is a mature, documented pattern. DAD-infra adopts it verbatim
so the two tenants feel like one codebase:

- **CDK TypeScript**, `aws-cdk-lib` 2.275.0, `constructs` 10.8.1, TS 5.9.3,
  jest/ts-jest 29.x, pinned exactly.
- **Typed per-env `config.ts`** with a `getConfig(env)` and the dummy-account
  offline-synth fallback.
- **One stack per file** under `lib/`, cross-references passed as props from
  `bin/*.ts`.
- **`aws-cdk-lib/assertions` unit tests** per stack asserting the resources that
  matter (not snapshots).
- **GitHub OIDC, no static keys.** Per-env `infra-deploy` / `app-deploy` roles. Each
  trusts exactly one repo's GitHub Environment: `infra-deploy` ← `DAD-infra`,
  `app-deploy` ← `DAD-Main`, with `sub = repo:<repo>:environment:<env>` (an exact
  match). Every deploy job runs under a GitHub Environment, and GitHub then issues
  that `sub` instead of the branch or tag form. The environments carry the
  branch/tag restrictions (see the README).
- **Actions pinned by full commit SHA** with `# vX.Y.Z` comments.
- **Offline-only verification.** `npm install`, `npm run build`, `jest`,
  `cdk synth -c env=staging` and `-c env=production` with dummy account/region.
  Never `cdk deploy` or live `aws` in verification.
- **Tagging:** `Project=dad`, `Environment=<env>`; ATM adds `Component=atm`.

---

## 6. ATM on AWS — architecture

### 6.1 Why ATM diverges from DAD-Main's compute

DAD-Main runs on **Fargate**. ATM cannot. ATM's entire job is to build Docker
images from a DAD-Main source archive, start a Docker Compose project (ephemeral
PostgreSQL clusters, API/web/nginx images), and drive it with a real Chromium via
Playwright. That requires a **privileged Docker daemon** (Docker-in-Docker).
Fargate does not provide one.

**Decision: ATM's runner is AWS CodeBuild**, which offers a Docker-enabled,
privileged build environment billed per-minute and is purpose-built for
"clone → build images → run → emit artifacts." Alternatives considered:

- **Fargate** — rejected: no privileged Docker daemon (ATM's hard requirement).
- **EC2 / AWS Batch with Docker** — viable but more standing ops (AMIs, patching,
  capacity). Reconsider if per-minute CodeBuild cost or build time becomes a
  problem.

This is the one deliberate divergence from DAD-Main's shape, documented so it is
not mistaken for inconsistency.

### 6.2 Components

- **CodeBuild project** (`atm-runner-<env>`), privileged mode, Docker enabled.
  Buildspec: resolve the DAD-Main revision → run `npm run atm -- run --repo <checkout>
  --revision <rev>` → capture exit code → post-run sync (§6.4) → exit with ATM's
  code so the pipeline gates correctly.
- **S3 evidence bucket** (`atm-evidence-<env>-<account>`): private, Block Public
  Access on, SSE (SSE-S3 or KMS), versioning, lifecycle expiry. Holds the bulky,
  immutable artifacts: `run.json`, `report.html`, traces, screenshots. Keyed by
  `<source-repo>/<revision>/<run-id>/…`.
- **DynamoDB finding ledger** (`atm-findings-<env>`): the small, keyed, mutable,
  concurrent-safe finding store (§6.3).
- **Secrets Manager**: `OPENAI_API_KEY` / `TINKER_API_KEY`, injected into the
  CodeBuild environment **only** when AI exploration is explicitly enabled. Never
  passed to the application containers (ATM already guards this locally).
- **Triggers**: EventBridge Scheduler (nightly/periodic) and manual start via console
  / CLI. DAD-Main's CI does not start runs yet (§6.5).
- **IAM**: a CodeBuild service role scoped to read its secrets, write the S3
  bucket prefix, and read/conditional-write the DynamoDB table — nothing else.
  The scheduler's role is allowed only `codebuild:StartBuild` on the project.

### 6.5 Trigger and source acquisition — scheduled runs; CI-triggered runs deferred

> **Status (2026-10-29): held, not deployed.** DAD-Main's ATM acceptance gate and its
> Cloudflare Worker ledger are the single source of truth for findings. That ledger
> accepts only GitHub OIDC tokens from `pre-dad/DAD-Main` on GitHub-hosted runners and
> binds every receipt to a GitHub Actions run (`run_id:run_attempt`) and its evidence
> artifact (`apps/atm-ledger/src/auth.ts`, `ledger.ts`). A CodeBuild run has neither, so
> this runner cannot publish to it, and deploying it alone would create a second,
> disconnected findings store (its DynamoDB table). `apps/atm` stays built and tested;
> no workflow deploys it. Revisit only for a need GitHub-hosted runs cannot
> meet (e.g. longer than the gate's job limit, or heavy AI exploration); then a GitHub
> job would start the run, collect its evidence as an artifact and publish with its own
> token, leaving the ledger's trust model unchanged. The rest of this section describes
> the runner as built. DAD-Docs ADR 0006.

**Decision: v1 runs are started by EventBridge Scheduler. Nothing in DAD-Main's CI
starts them.** No AWS-side webhook or public ingress.

**Source acquisition:** the runner clones DAD-Main itself; the buildspec checks out the
revision under validation (`--source-version` from `StartBuild`, otherwise the default
branch). DAD-Main is a public repository, so a scheduled run clones anonymously. A caller
of `StartBuild` may supply `GITHUB_APP_TOKEN` to authenticate the clone. This breaks
for scheduled runs if DAD-Main ever becomes private; a stored read-only credential would
then be needed. (Not verified: that CodeBuild's own GitHub source needs no credential for
a public repository.) Rejected alternative: DAD-Main CI builds a source archive and hands
it to ATM. ATM already resolves and archives committed source itself, so that would
duplicate or bypass it.

**Why CI-triggered runs are deferred.** There is no `codebuild:StartBuild` OIDC role for
DAD-Main's CI. DAD-Main already has an ATM acceptance gate (`atm.yml`) with its own
durable findings ledger (a Cloudflare Worker, `apps/atm-ledger`), and that installation
is documented as authoritative. A CI-started AWS run would write to the DynamoDB ledger
(§6.3), which that gate never reads, so findings would live in two disconnected places.
Settle first whether AWS runs *complement* the gate (nightly and heavier runs, their own
ledger) or *integrate* with the Worker ledger. Then wire CI:

- a DAD-Main workflow job that assumes a `StartBuild` role. If the job runs under a
  GitHub Environment the OIDC `sub` is the environment form, otherwise the branch form;
  the role must trust the one the job actually produces;
- the role also needs `codebuild:BatchGetBuilds` on the project for the job to wait for
  the result;
- an account has exactly one GitHub OIDC provider. `apps/dad-main`'s `pipeline-iam` stack
  owns it, and `apps/atm` must not create another.

End-to-end path (v1):

```
EventBridge Scheduler (nightly) → codebuild:StartBuild atm-runner-<env>
CodeBuild (privileged Docker)
  → clone DAD-Main @ default-branch HEAD
  → npm run atm -- run --repo <checkout> --revision <sha>
  → capture ATM exit code
  → post-run sync: evidence → S3, findings → DynamoDB (conditional writes)
  → exit with ATM's code
```

### 6.3 Finding-ledger decision — DynamoDB

**Decision: DynamoDB for the finding ledger; S3 for evidence.**

ATM's value is cross-run, concurrency-safe finding accumulation: findings are
grouped by `(source repo, check, normalized error signature)`, they block across
runs (including historical and other branches), a resolved finding reopens when
its signature recurs, and triage keeps an assessment history. That is a keyed,
mutable, read-modify-write record set.

- **Concurrency:** commit-triggered runs can finish near-simultaneously and both
  update the ledger. DynamoDB conditional writes give safe optimistic concurrency
  for free; an S3 "ledger file" would need hand-built locking/versioning, and
  ATM's local single-writer lock does not translate to ephemeral runners.
- **Query pattern:** "unresolved blocking findings for this source repo" is a
  key/GSI lookup in DynamoDB vs. download-and-scan in S3.
- **Future B:** a hosted dashboard wants a queryable store, not a JSON blob to
  pull and parse. DynamoDB is the same store A writes and B later reads.

Sketch schema (to be finalized during implementation):

- **PK** = `source#<repo>` · **SK** = `finding#<normalized-signature>`
- Attributes: `check`, `severity`, `status` (unassessed/confirmed/resolved/dismissed/reopened),
  `firstSeenRunId`, `lastSeenRunId`, `assessmentHistory[]`, `reproCommand`.
- **GSI** on `status` (or `severity`) per source for the "blocking findings" query.
- Writes use conditional expressions for reopen-on-recurrence and
  resolve/dismiss transitions.

Split restated: **DynamoDB = ledger** (small, mutable, concurrent);
**S3 = evidence** (bulky, immutable, hashed). Mirrors DAD-Main's RDS-vs-everything
separation of mutable state from artifacts.

### 6.4 The storage-decoupling problem and the v1 call

ATM today writes history to a **single-writer local filesystem** under
`.atm/runs/`, bound to an absolute repo path and guarded by a lock. That model
does not survive on ephemeral CodeBuild. Two ways to bridge it:

1. **Native cloud backend inside ATM** — teach ATM an S3/DynamoDB history +
   ledger backend. Correct long-term, but a real change to ATM's core storage
   layer.
2. **Thin post-run sync wrapper** — run ATM unchanged on the CodeBuild host,
   then a post-run step uploads evidence to S3 and reconciles the local finding
   ledger into DynamoDB with conditional writes.

**Decision for v1: the thin post-run wrapper.** It ships A without rewriting
ATM's storage layer, keeps the infra work and the ATM-core work decoupled, and
still makes the right long-term storage choice (S3 + DynamoDB). A native backend
inside ATM is a later increment once the shape is proven.

Honest caveat: even the wrapper is **a code change that lives in the atm repo**
(a new post-run sync script + the buildspec that calls it), not pure IaC. The
implementation plan tracks it as an atm-repo item distinct from the DAD-infra
CDK items.

---

## 7. DAD-Main extraction

Moving DAD-Main's finished-but-parked `infra/` into DAD-infra is low-risk right
now — nothing is deployed, there is no CloudFormation state to migrate, and
offline synth verifies the move — but it is real work and it touches the DAD-Main
repo:

- Move `lib/`, `bin/`, `test/`, `cdk.json`, `jest.config.js`, `tsconfig.json`
  into `apps/dad-main/`.
- De-duplicate `config.ts` → `packages/config`; have `apps/dad-main` import it.
- De-duplicate the OIDC provider from `pipeline-iam-stack.ts` → `packages/pipeline-iam`
  (provider shared; DAD-Main's `infra-deploy`/`app-deploy` roles stay app-scoped).
- Update DAD-Main's `.github/workflows/infra.yml` and `deploy.yml` to point at the
  new repo/location (or move them into DAD-infra with path filters).
- Re-run DAD-Main's offline verification gate from the new location to prove
  byte-for-byte-equivalent synth output.

The extraction is complete: DAD-Main's CDK app is `apps/dad-main`.

---

## 8. Security and cost posture

- **No deploy until the team is ready.** The estate stays offline-verified and
  parked to avoid AWS charges, exactly as DAD-Main's infra is today.
- **Least privilege.** CodeBuild's role is scoped to its own S3 prefix, its
  DynamoDB table, and its named secrets. No broad `*` on data stores.
- **Evidence is private.** Bucket has Block Public Access, SSE, and lifecycle
  expiry; ATM treats run directories as private (synthetic one-use invitations,
  session cookies in traces). No public report hosting in v1.
- **AI keys isolated.** Provider keys live in Secrets Manager, enter the runner
  only when AI is explicitly enabled, and never reach application containers.
- **Cost controls to decide at implementation:** CodeBuild compute size + build
  timeout, S3 lifecycle expiry window, DynamoDB on-demand vs. provisioned
  (on-demand likely, given spiky commit-triggered load).

---

## 9. What is built

- **Shared packages:** `packages/config` (account map, region, `-c env`) and
  `packages/pipeline-iam` (the one GitHub OIDC provider per account; deploy roles can
  only trust a GitHub Environment).
- **`apps/dad-main`:** the DAD-Main estate, extracted from DAD-Main. Application secrets
  start empty, SMTP credentials rotate automatically, a one-off task creates the database
  owner role, services have health checks and roll back, images are tagged from the
  last deployed release, and workers have one switch (off by default). First deploy:
  [`docs/bootstrap.md`](../bootstrap.md).
- **`apps/atm`:** the DAD-Quality runner on AWS, built and tested, held and not deployed
  (§6.5).
- **Out of scope:** the hosted multi-user dashboard ("Path B").

Operating rules that came out of building it are recorded in DAD-Docs ADR 0005; the
ledger decision in ADR 0006.

---

## 10. Open questions

1. **"DAAD-website" spelling.** Confirm the double-A is intentional and not a typo
   of the "DAD-" prefix used everywhere else.
2. **Evidence retention window.** How long to keep run evidence in S3 before
   lifecycle expiry? (ATM's local retention is manual; cloud should be explicit —
   propose a concrete default in the plan, e.g. 90 days staging / longer production.)
3. **GitHub read for the CodeBuild clone.** Scheduled runs clone anonymously while
   DAD-Main is public (§6.5). If it becomes private, decide between a stored read-only
   credential and a minted short-lived App token.
4. **Website as a future tenant.** Leave out entirely, or add a tracking stub for
   when its Lightsail/DNS resources become IaC-managed?
