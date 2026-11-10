# Agent guide — DAD-infra

AWS CDK (TypeScript) estate for DAD: npm workspaces, one CDK app per tenant. Start with
these; this file only adds what they do not say.

- **[README.md](README.md)** — layout, environments, sizing, GitHub Environments and
  deploy roles, offline verification.
- **[docs/design/aws-infra-design.md](docs/design/aws-infra-design.md)** — authoritative
  architecture; [docs/bootstrap.md](docs/bootstrap.md) — first deploy of an environment;
  [docs/branch-protection.md](docs/branch-protection.md) — the applied rulesets.
- Cross-repo rules live in the separate **DAD-Docs** repo: ADR 0004 (this repo is the
  single home for AWS) and ADR 0005 (platform operating standards). There is no
  CONTRIBUTING.md here.
- **[Shared agent workflow](https://github.com/pre-dad/DAD-Docs/blob/dev/conventions/agent-workflow.md)** —
  read DAD-Docs for skill setup, routing, and independent-review boundaries. Keep
  shared procedures there; this guide owns repo-local commands and constraints.

## Guardrails

- **Deploys are owner-run or pipeline-run, never agent-run.** Do not run `cdk deploy`,
  `cdk bootstrap`, `cdk destroy`, or any `aws`/CloudFormation command that reaches an
  account unless the owner explicitly tells you to. The `gh api` ruleset commands in
  `docs/branch-protection.md` are also owner-run.
- **Targets:** `-c env=staging` is the sandbox account, `-c env=production` is the
  production account, both `us-east-2` (`packages/config`). Deploys go through GitHub
  OIDC deploy roles; production only by a push to `main` under the `production`
  Environment (ADR 0005 #4). No static keys, no tag-triggered deploys.
- **Secrets:** IaC creates the place a credential lives, never the value (ADR 0005 #2).
  No IAM access keys or secret values in templates; tests enforce this. Do not read or
  print `.env` or credential files.
- **Stack names and outputs are an API** for DAD-Main's `deploy.yml` (`dad-<name>-<env>`,
  `ClusterName`, `ComputeSubnetIds`, `WorkersSecurityGroupId`). Change both repos together.
- **`apps/atm` is built and tested but deliberately not deployed** (ADR 0006). Do not add
  deploy jobs for it.
- **Tags:** the apps tag everything `Project=dad` and `Environment=<env>`; `apps/atm` also
  sets `Component=atm`. Keep that when adding stacks.

## The gate (run before every push; CI's `synth` check runs the same, offline)

```sh
npm ci
npm run build
npx jest --ci --maxWorkers=2 --workerIdleMemoryLimit=1024MB   # needs python3
cd apps/dad-main   # and apps/atm
CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=us-east-2 npx cdk synth -c env=staging >/dev/null
CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=us-east-2 npx cdk synth -c env=production >/dev/null
```

`cdk synth` here uses dummy credentials and touches no AWS. There is no lint script, and
the repo has no `cdk diff` step in CI (it needs credentials).

## Branch and push discipline

- Work on `dev`; ship via `dev` → PR → `main`. Never push to `main` directly. Both
  branches are protected by rulesets requiring the `synth` check.
- Run `git commit` and `git push` as two separate commands.
- Do not use the admin bypass past a failing or still-running check (ADR 0005 #6).
- Pushes to `dev` and `main` that touch `apps/dad-main/**` or `packages/**` trigger
  real deploys once `INFRA_DEPLOY_ROLE_ARN` is set. Treat a push as a deploy.

## Code comments

- Comments explain **why** (a constraint, a trade-off, a non-obvious behavior), not what the
  code already says.
- No commented-out code (git keeps history). A `TODO` names a tracked issue.

## Gotchas not written in the docs

- **Never track working documents** (plans, status, findings, session notes). Tracked
  `docs/` is durable design docs only. `.gitignore` here ignores `.agents/` but not
  `docs/requirements/`, so keep working notes in `.agents/` or outside the repo.
- **Renaming the `synth` job** in either workflow breaks the required check; update the
  ruleset in the same change.
- **Each jest suite synthesizes the whole app** and is memory-heavy; keep the worker cap.
