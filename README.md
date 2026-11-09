# DAD-infra

A single home for the DAD AWS CDK estate. An npm-workspaces monorepo with one
shared config/pipeline core and one CDK app per tenant.

```
DAD-infra/
  packages/
    config/          # shared account map, region, EnvName, getConfig()
    pipeline-iam/    # shared GitHub OIDC provider + scoped deploy-role helper
  apps/
    dad-main/        # DAD-Main estate: VPC, RDS + Proxy, ECS Fargate, SES, NLB, pipeline IAM
      lambda/        #   SES SMTP credential rotation function (Python)
    atm/             # DAD-Quality runner on AWS: built and tested, NOT deployed (see design §6.5)
  cloudflare/        # edge rate limits and firewall rules for the DAD hostnames (see its README)
  docs/
    design/          # architecture and decisions
    bootstrap.md     # first deploy of an environment
    branch-protection.md
```

## Design

The authoritative architecture, account/region model, and decisions live in
[docs/design/aws-infra-design.md](docs/design/aws-infra-design.md).

## Environments

- `staging` → sandbox account `853377042897`
- `production` → account `216833405626`
- Region: `us-east-2` (Ohio)

Environment is selected with `-c env=staging|production` (default `staging`).

## Sizing and scaling

Values live in `apps/dad-main/lib/config.ts`. No load test has been run against these
sizes, so the limits below are the configured ceilings and the levers, not measured
capacity.

| | staging | production |
|---|---|---|
| Availability zones | 2 subnets per tier, 1 NAT gateway | 2 subnets per tier, 2 NAT gateways |
| Database | RDS PostgreSQL 16, `db.t4g.small`, single-AZ, 7-day backups | `db.t3.large`, Multi-AZ, 14-day backups, daily and monthly copies to us-west-2 (see [docs/disaster-recovery.md](docs/disaster-recovery.md)) |
| Storage | 20 GiB gp3, autoscaling to 200 GiB | 50 GiB gp3, autoscaling to 200 GiB |
| api task | 0.25 vCPU, 0.5 GiB | 1 vCPU, 2 GiB |
| web task | 0.5 vCPU, 1 GiB | 1 vCPU, 2 GiB |
| nginx / worker task | 0.25 vCPU, 0.5 GiB | 0.5 vCPU, 1 GiB |
| api, web, nginx tasks | 1 each, scaling to 3 / 3 / 2 | 3 each (floor), spread across both AZs with rebalancing, scaling to 12 / 12 / 6 |
| Workers | 6 services, 1 task each, off until `workersEnabled` | same |
| Interface VPC endpoints | off (traffic uses the NAT) | on |
| Container Insights, service-health alarms | off | on |
| VPC flow logs | rejected traffic only | all traffic |

The api, web and nginx services scale on average CPU (60%) and, for api and web, memory
(75%). The floor is the configured desired count and the ceiling is `autoscaling.<service>.maxCount`.
Traffic enters through a Network Load Balancer, which has no per-target request metric,
so there is no request-count policy. Workers do not autoscale. The S3 gateway endpoint is
always created; the ECR api/dkr, Secrets Manager and CloudWatch Logs interface endpoints
(`interfaceEndpointsEnabled`) keep image pulls, secret resolution and log delivery off the
NAT. VPC flow logs (`flowLogTrafficType`) go to `/dad/<env>/vpc-flow-logs` with
`flowLogRetentionDays`. The ECS service-health alarms read Container Insights metrics, so
they exist only where `containerInsights` is on; staging keeps the database alarms only.

Staging is single-AZ for the database and has one NAT gateway, so an AZ outage takes it
down; production is Multi-AZ for the database and has a NAT per AZ.

### Scaling path

The first constraint is the database, not the web tier: every api task and worker shares
one `db.t3` instance behind RDS Proxy, which pools connections but does not add CPU.

- **About 50,000 users.** Raise the task ceilings and desired counts in `config.ts`
  (the autoscaling floor is `desiredCounts`, so raise it when sustained load sits above
  it). Move the production database off burstable `t3` to a fixed-performance class
  (`m6g`/`r6g`), watching the `DatabaseCpu` alarm and Performance Insights. Turn the
  workers on and size `taskSizes.worker` to the mail and Stripe volume.
- **About 1,000,000 users.** Add an RDS read replica and route read-only queries to it
  (an application change in DAD-Main), raise `maxAllocatedStorage`, and move to a larger
  database class or Aurora PostgreSQL. Split the worker tiers into separate services with
  their own counts, and replace the fixed NLB-to-nginx fan-out limits (task ceilings,
  NAT throughput) with measured values from a load test run against staging first.

### Production safeguards

Production stacks have termination protection (`deletionProtection`), the RDS master,
per-login and SMTP secrets are retained on stack deletion, and the database is copied to
a second region by AWS Backup. Restore steps, RPO/RTO assumptions and the first-deploy
checks are in [docs/disaster-recovery.md](docs/disaster-recovery.md). Staging keeps all of
these off so it stays cheap and deletable.

Neither step is applied: instance classes are unchanged until a load test justifies them.

## GitHub Environments and deploy roles

Deploys authenticate with GitHub OIDC (no static keys). Every deploy job runs under a
GitHub Environment named `staging` or `production`, so GitHub issues the token with
`sub = repo:<owner>/<repo>:environment:<name>`, and each role trusts exactly that for
exactly one repo:

| Repo | Workflow | Role (created by `apps/dad-main` pipeline-iam) | Environment variable |
|---|---|---|---|
| `pre-dad/DAD-infra` | `dad-main-infra.yml` | `dad-<env>-infra-deploy` | `INFRA_DEPLOY_ROLE_ARN` |
| `pre-dad/DAD-Main` | `deploy.yml` | `dad-<env>-app-deploy` | `APP_DEPLOY_ROLE_ARN` |

Create the `staging` and `production` environments in **both** repos and set the
variable on each (the role ARN is a stack output of the account's `pipeline-iam`
stack). Also set a repository-level variable of the same name: both pipelines read the
switch outside the Environment (a job-level `if` in `dad-main-infra.yml`, the `ci-gate`
step in `deploy.yml`), which sees only repository variables, so the
repository value is the on-switch and the Environment value overrides it inside the job.
The credentialed jobs stay skipped until the repository variable is set. The shared
`synth` job validates both CDK apps; only DAD-Main has deployment jobs (the ATM runner
is held).

**The environment is the access control.** Any job in the trusted repo that runs under
the environment can assume the role, so restrict deployments in each environment's
settings: `staging` to the `dev` branch; `production` to `main`, with required reviewers.
Production is deployed only by a push to `main`: there is no release- or tag-triggered
path. Without a deployment-branch rule, a workflow on any branch could
select the environment.

## Offline verification (no deploys)

The NLB target health check (TCP on the traffic port) and the `web`/`api` Service Connect names nginx and web rely on were checked against DAD-Main's nginx config but not against AWS; see [docs/bootstrap.md](docs/bootstrap.md#verified-against-code-not-against-aws). Nothing is deployed yet; the first deploy follows [docs/bootstrap.md](docs/bootstrap.md).
The checks below are offline and need no AWS credentials. CI's required `synth` check
runs the same tests and synth on every PR.

```sh
# from the repo root
npm install
npm run build
npx jest   # all workspaces; also runs the rotation function's Python tests (needs python3)

# per-app offline synth (dummy account/region), for apps/dad-main and apps/atm
cd apps/dad-main
CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 npx cdk synth -c env=staging
CDK_DEFAULT_ACCOUNT=111111111111 CDK_DEFAULT_REGION=us-east-2 npx cdk synth -c env=production
```
