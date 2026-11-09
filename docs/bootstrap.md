# First deploy of an environment (bootstrap runbook)

How to bring up `staging` or `production` for the first time. Later releases need none
of this: DAD-Main's `deploy.yml` deploys the application, and `dad-main-infra.yml`
deploys infrastructure changes. (`atm-infra.yml` only runs checks: the DAD-Quality runner
is not deployed.)

Everything here runs once per environment, by an operator with administrator access to
that account, in `us-east-2`. Commands assume `ENV=staging` (or `production`) and a shell
authenticated to the matching account.

**Order matters.** ECS services cannot be created before the images and secrets they
need exist, and the API, web and workers refuse to start before the database roles exist.
CloudFormation waits for a new service to stabilize, and with the circuit breaker on, a
service that cannot start fails the stack. So the stacks are deployed in groups, with
manual steps between them.

### Pin the region and account before deploying

Export the profile and region first, for example
`export AWS_PROFILE=<profile> AWS_REGION=us-east-2 AWS_DEFAULT_REGION=us-east-2`. The
`cdk` CLI sets `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` from the profile, which
overrides the dummy values used for offline synth, and the stacks hardcode `us-east-2`
zones. Before any deploy, synthesize from `apps/dad-main` (the only directory with a
`cdk.json`) and confirm the manifest names only the expected account in `us-east-2`:

```sh
cd apps/dad-main
npx cdk synth -c env=$ENV -q --output /tmp/dad-synth
grep -o 'aws://[0-9]*/[a-z0-9-]*' /tmp/dad-synth/manifest.json | sort -u
```

Staging should show exactly `aws://<staging-account>/us-east-2`. Production should show
exactly `aws://<prod-account>/us-east-2` and `aws://<prod-account>/us-west-2` (the
cross-region backup vault, `dad-dr-vault-production`).

## Steps

### 1. CDK bootstrap the account

```sh
npx cdk bootstrap "aws://<account-id>/us-east-2"
```

For production, also bootstrap the disaster-recovery region (the cross-region backup
vault deploys there; see [disaster-recovery.md](disaster-recovery.md)):

```sh
npx cdk bootstrap "aws://<account-id>/us-west-2"
```

### 2. Deploy the foundation stacks

From `apps/dad-main`:

```sh
npx cdk deploy -c env=$ENV \
  dad-network-$ENV dad-data-$ENV dad-ecs-cluster-$ENV \
  dad-ses-$ENV dad-app-secrets-$ENV dad-pipeline-iam-$ENV
```

In production also deploy `dad-dr-vault-production` and `dad-backup-production` (the
database backup copies; check them as listed in [disaster-recovery.md](disaster-recovery.md)).

This creates the VPC, the database, the RDS Proxy and the per-login secrets, the cluster,
the three ECR repositories, the SES identity, the application secrets (with empty
values), and the GitHub OIDC provider and deploy roles. It does not create any ECS
service or task definition.

Add the DKIM and verification records from the `dad-ses-$ENV` outputs in Cloudflare. SES
starts in sandbox mode; request production access before sending to arbitrary addresses.

### 3. Build and push the first images

The services stack tags every image with the value of `/dad/$ENV/image-tag`, so that tag
must exist in all three repositories first. From a DAD-Main checkout at the commit to
deploy:

```sh
TAG=$(git rev-parse HEAD)
REGISTRY=<account-id>.dkr.ecr.us-east-2.amazonaws.com
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin "$REGISTRY"
docker build -t "$REGISTRY/dad/api:$TAG" -f apps/donor-api/Dockerfile .
docker build -t "$REGISTRY/dad/web:$TAG" \
  --build-arg DONOR_PUBLIC_ORIGIN=<public origin> \
  --build-arg DONOR_STAFF_ORIGIN=<staff origin> \
  -f apps/web/Dockerfile .
docker build -t "$REGISTRY/dad/nginx:$TAG" deploy/nginx
docker push "$REGISTRY/dad/api:$TAG"
docker push "$REGISTRY/dad/web:$TAG"
docker push "$REGISTRY/dad/nginx:$TAG"
```

The build commands match `deploy.yml`. Build for `linux/amd64` (Fargate's default) if you
are on Apple silicon: add `--platform linux/amd64`.

### 4. Create the image-tag parameter

```sh
aws ssm put-parameter --name "/dad/$ENV/image-tag" --type String --value "$TAG" \
  --region us-east-2
```

CDK reads this parameter and never writes it. From now on `deploy.yml` updates it after
each successful rollout.

### 5. Fill in the application secrets

Each is JSON. Replace the whole value; keep every field (an empty string means unset).

```sh
aws secretsmanager put-secret-value --secret-id "dad/$ENV/ingress/tls" \
  --secret-string "$(jq -n --rawfile c fullchain.pem --rawfile k privkey.pem \
    '{INGRESS_TLS_FULLCHAIN: $c, INGRESS_TLS_PRIVKEY: $k}')"

aws secretsmanager put-secret-value --secret-id "dad/$ENV/app/encryption" \
  --secret-string '{"DONOR_EMAIL_ENCRYPTION_KEY":"<key>","DONOR_CONTENT_ENCRYPTION_KEY":"<key>"}'

# Optional now; the API requires both Stripe values or neither.
aws secretsmanager put-secret-value --secret-id "dad/$ENV/app/stripe" \
  --secret-string '{"STRIPE_SECRET_KEY":"<key>","STRIPE_WEBHOOK_SECRET":"<secret>"}'
```

- **TLS** is required: nginx does not start without it. In Cloudflare mode use a
  [Cloudflare Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)
  certificate for both hosts (DAD-Main `docs/edge.md`).
- **Encryption keys** are crown jewels. Generate them as DAD-Main `docs/operations.md`
  describes, back them up outside AWS before using them, and never rotate them
  automatically. Losing one makes the data it protects permanently unreadable.
- **SMTP** needs nothing: `dad/$ENV/ses/smtp` is filled by its rotation function, which
  runs when the SES stack is created and every 90 days after. If the first rotation failed
  (its log group is `/dad/$ENV/smtp-rotation`), fix the cause and run
  `aws secretsmanager rotate-secret --secret-id dad/$ENV/ses/smtp`.

Optional live sign-in uses two separate JSON secrets, created with empty fields:

- `dad/$ENV/app/sign-in` goes to the API only: `DONOR_SMS_PROVIDER`,
  `DONOR_SMS_ACCOUNT_ID`, `DONOR_SMS_AUTH_TOKEN`, `DONOR_SMS_FROM`, `DONOR_OIDC_MODE`,
  `DONOR_OIDC_APPLE_CLIENT_ID`, `DONOR_OIDC_GOOGLE_CLIENT_ID`, and
  `DONOR_OIDC_REQUIRE_NONCE`.
- `dad/$ENV/app/web-oauth` goes to web only: `DONOR_OAUTH_APPLE_CLIENT_ID`,
  `DONOR_OAUTH_APPLE_CLIENT_SECRET`, `DONOR_OAUTH_GOOGLE_CLIENT_ID`, and
  `DONOR_OAUTH_GOOGLE_CLIENT_SECRET`.

Keep all fields, including empty ones: ECS fails task startup if an injected JSON key
is missing. Leave the secrets empty until provider provisioning is complete. Follow
DAD-Main `docs/operations.md` (Phone and social sign-in; Web identity) for provider
values, redirect URLs, and matching web/native audiences. Stubs and their test opt-in
are not injected. Changing secret values takes effect only when replacement tasks
start; run an owner-approved rollout after updating them. For an existing estate,
deploy the app-secrets stack before updating services so the new secrets exist.

### 6. Deploy the maintenance stack and prepare the database

```sh
npx cdk deploy -c env=$ENV dad-maintenance-$ENV
```

Then, from DAD-Main, with the cluster, compute subnets and workers security group from
the `dad-ecs-cluster-$ENV` and `dad-network-$ENV` outputs:

```sh
export DAD_CLUSTER=<ClusterName> DAD_SUBNETS=<ComputeSubnetIds> \
  DAD_SECURITY_GROUPS=<WorkersSecurityGroupId> AWS_REGION=us-east-2
# Once: create the `owner` role, as the RDS master, directly against the instance.
DAD_SECURITY_GROUPS=<BootstrapSecurityGroupId from dad-data-$ENV> \
  scripts/run-task.sh $ENV bootstrap-owner
scripts/run-task.sh $ENV migrate
scripts/run-task.sh $ENV provision-roles
```

`bootstrap-owner` is the only task that can read the master secret, and the only thing
besides the RDS Proxy that may reach the instance. Privileged database work is versioned
code run as a one-off task; there is no bastion and no human database shell. It creates
`owner` if missing, resets its password to `dad/$ENV/db/owner`, makes the master a member
of it (a non-superuser master needs that to transfer a database), and gives it the
`dad` database. Safe to re-run, for example after rotating the owner password. Verified on
PostgreSQL 16 with a non-superuser master (wrong passwords rejected, the password re-synced
on a second run, a quote in the password handled); not yet run against RDS.

Each task waits and fails unless it exits 0. Without `DAD_TASKDEFS_FILE` they run
the latest revision, which CDK just created at `$TAG`.

### 7. Deploy the services and the edge

```sh
npx cdk deploy -c env=$ENV \
  dad-edge-$ENV dad-services-$ENV dad-observability-$ENV
```

The services stack depends on the edge stack (it references the NLB target groups), so
edge deploys first. CDK orders them from that dependency whatever order you list them in.

The NLB admits only Cloudflare's published ranges on 80 and 443. The list is built in
(`apps/dad-main/lib/edge-stack.ts`); check it against
[ips-v4](https://www.cloudflare.com/ips-v4) and [ips-v6](https://www.cloudflare.com/ips-v6)
before a deploy, and override it with `-c cloudflareRanges="<cidr> <cidr> ..."` if it has
changed. Set `alarmEmail` to subscribe an address to the alarm topics (confirm the
subscription email AWS sends). CI deploys pass no `-c` flags beyond `env`, so put either
value under `context` in `apps/dad-main/cdk.json` to keep it across deploys.

Point the public and staff hostnames in Cloudflare (proxied) at the NLB DNS name from the
`dad-edge-$ENV` outputs.

### 8. Configure GitHub for later deploys

For each repository's `$ENV` GitHub Environment (already created, with branch rules):

| Repository | Variable | Value |
|---|---|---|
| pre-dad/DAD-infra | `INFRA_DEPLOY_ROLE_ARN` | `InfraDeployRoleArn` output of `dad-pipeline-iam-$ENV` |
| pre-dad/DAD-Main | `APP_DEPLOY_ROLE_ARN` | `AppDeployRoleArn` output of `dad-pipeline-iam-$ENV` |
| pre-dad/DAD-Main | `DONOR_PUBLIC_ORIGIN`, `DONOR_STAFF_ORIGIN` | the environment's origins |

The role variables need two levels. The deploy jobs gate on a job-level
`if: vars.<NAME> != ''`, which sees only repository-level variables, so an
Environment-only value leaves them skipped. Set a repository-level variable of the same
name (the on-switch) and, on each Environment, a variable of that name holding that
account's role ARN. Inside the job the Environment value overrides the repository one, and
`role-to-assume` reads it. Unsetting the repository variable switches the deploy jobs off.
DAD-Main's `deploy.yml` evaluates its switch in a step and reports when it is off;
`dad-main-infra.yml` simply skips. `DONOR_PUBLIC_ORIGIN` and `DONOR_STAFF_ORIGIN` are read
only inside the job, so Environment-level is enough.

### Turning the workers on

Workers are off in every environment until `workersEnabled` is set to `true` in
`apps/dad-main/lib/config.ts` and the services stack is deployed. That setting is the one
switch: it sets their desired count, and DAD-Main's `deploy.yml` rolls only services ECS
reports as running. Turn them on once mail (SES out of sandbox, a working SMTP password)
and, if used, Stripe are configured.

### Autoscaled services and the app-deploy role

api, web and nginx scale between their `desiredCounts` and `autoscaling.<service>.maxCount`.
Their desired count is not in the template, so a later `cdk deploy` leaves a scaled-out
service where it is. To resize permanently, change `desiredCounts` (the floor) or
`maxCount` and deploy.

The `app-deploy` role may pass only roles named `dad-services-$ENV-*` and
`dad-maintenance-$ENV-*` to ECS tasks, and may run only the `dad-maint-*` task
definitions in the `dad-$ENV` cluster. These names are the generated names of the task and
execution roles in those two stacks; do not give those roles explicit names unless the
`PassTaskRoles` statement in `apps/dad-main/lib/pipeline-iam-stack.ts` is updated too.

### Database passwords are ECS secrets

No task definition holds a database password in `environment`. Each task has a
password-less URL (`DONOR_API_DATABASE_URL=postgresql://dad_api_login@<proxy>:5432/dad?...`)
and the login's password as an ECS secret under the matching `..._DATABASE_PASSWORD`
variable (valueFrom the login secret's `password` key). The URL form is used rather than
separate host/name/user parts because it keeps `default_query_exec_mode=exec`, which the RDS
Proxy needs. Each execution role can read only the login secrets its task injects; the
`app-deploy` role needs no secret access, since `ecs-pin-image.sh` copies `secrets` verbatim
into the new revision.

Deploy ordering: DAD-Main from commit 7506cbf accepts both forms (a full URL still wins),
so deploy DAD-Main with 7506cbf first, then this change at any time after. Rolling this out
before that DAD-Main release makes the processes fail to find a password. Rolling back
either side is safe while the other still supports the form in use. Rotating a password
changes the secret value only: restart the service, no redeploy of the template.

### 9. DAD-Quality runner: not deployed

Do not deploy `apps/atm`. DAD-Main's ATM gate and its Worker ledger are the single source
of truth for findings, and this runner cannot publish to that ledger (design doc §6.5,
DAD-Docs ADR 0006).

## Verified against code, not against AWS

Nothing in this runbook has been run: no environment exists yet. Two reported first-deploy
blockers were checked against DAD-Main's `deploy/nginx` and fixed here:

- **NLB health check.** nginx binds `/health` to `127.0.0.1:8081` (`nginx.conf`), which the
  NLB cannot reach, so the old HTTP check on 8081 would have left every target unhealthy.
  The target groups now use a TCP check on the traffic port (8443, 8080); the 8081 security
  group rule and port mapping are gone. The container health check still probes
  `127.0.0.1:8081/health` inside the task, and ECS registers a task only once that passes.
  DAD-Main needs no change.
- **`web` resolution.** nginx's `server web:3000;` (the Dockerfile removes the Docker
  resolver) needs a Service Connect name. `web` now publishes itself as `web:3000`, nginx
  joins the namespace as a client, and the nginx service waits for the web service. The
  existing nginx to web:3000 and web to api:8002 security group rules carry that traffic.

Target group deregistration delay is 30 seconds (the default is 300).

Still not verifiable without AWS: that CloudFormation creates the services in one pass once
steps 3 to 6 are done, that the Service Connect proxy in the nginx task resolves `web` at
nginx start, and that the NLB targets turn healthy.
