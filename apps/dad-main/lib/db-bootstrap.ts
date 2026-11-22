import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { TaskSize } from './config';

/**
 * PostgreSQL client image for the owner bootstrap, pinned by digest (the same pin
 * DAD-Main CI uses for its Postgres service). Not a DAD image, so DAD-Main's pin step
 * must never re-tag it: `deploy.yml` lists the families it pins, and this one is not in
 * the list.
 */
export const BOOTSTRAP_CLIENT_IMAGE =
  'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';

/** AWS's published bundle of RDS certificate authorities, for `sslmode=verify-full`. */
export const RDS_CA_BUNDLE_URL =
  'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';

/**
 * Creates (or re-syncs) the `owner` role and gives it the application database.
 *
 * Runs as the RDS master user, connecting directly to the instance (the master secret is
 * deliberately NOT registered with the RDS Proxy). Safe to re-run: the role is created
 * only if missing, its password is always reset to the value in `dad/<env>/db/owner`, and
 * the grant and ownership change are idempotent. Passwords are read from the
 * environment by psql (`\getenv`, psql 15+) and quoted by `format(%L)`; they never appear
 * in the command line.
 *
 * `GRANT owner TO <master>` is required: a master that is not a superuser (RDS) may make a
 * role a database's owner only if it is a member of that role.
 */
export const OWNER_BOOTSTRAP_SCRIPT = `set -eu
: "\${DB_HOST:?}" "\${DB_NAME:?}" "\${MASTER_USER:?}" "\${MASTER_PASSWORD:?}" "\${OWNER_PASSWORD:?}"
export PGSSLMODE="\${PGSSLMODE:-verify-full}"
if [ "$PGSSLMODE" = verify-full ]; then
  wget -q -O /tmp/rds-ca.pem "\${RDS_CA_URL:?}"
  export PGSSLROOTCERT=/tmp/rds-ca.pem
fi
export PGHOST="$DB_HOST" PGDATABASE="$DB_NAME" PGUSER="$MASTER_USER" PGPASSWORD="$MASTER_PASSWORD"
psql -v ON_ERROR_STOP=1 -X -q -v master="$MASTER_USER" -v db="$DB_NAME" <<'SQL'
\\getenv owner_pw OWNER_PASSWORD
SELECT 'CREATE ROLE owner' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'owner') \\gexec
SELECT format('ALTER ROLE owner WITH LOGIN CREATEROLE PASSWORD %L', :'owner_pw') \\gexec
GRANT owner TO :"master";
ALTER DATABASE :"db" OWNER TO owner;
SQL
echo "bootstrap-owner: owner role ready and owns database $DB_NAME"
`;

/** Inputs for {@link ownerBootstrapTaskDefinition}. */
export interface OwnerBootstrapProps {
  /** Fargate sizing; the task family is `dad-maint-bootstrap-owner`. */
  readonly size: TaskSize;
  readonly logGroup: logs.ILogGroup;
  /** The RDS instance endpoint address (not the proxy). */
  readonly databaseHost: string;
  readonly databaseName: string;
  /** The RDS-generated master secret (`username`, `password`). */
  readonly masterSecret: secretsmanager.ISecret;
  /** `dad/<env>/db/owner` (`password`). */
  readonly ownerSecret: secretsmanager.ISecret;
}

/** The one-off task definition that runs {@link OWNER_BOOTSTRAP_SCRIPT}. */
export function ownerBootstrapTaskDefinition(
  scope: Construct,
  props: OwnerBootstrapProps,
): ecs.FargateTaskDefinition {
  const taskDefinition = new ecs.FargateTaskDefinition(scope, 'maint-bootstrap-owner-TaskDef', {
    cpu: props.size.cpu,
    memoryLimitMiB: props.size.memoryMiB,
    family: 'dad-maint-bootstrap-owner',
  });
  taskDefinition.addContainer('maint-bootstrap-owner-Container', {
    image: ecs.ContainerImage.fromRegistry(BOOTSTRAP_CLIENT_IMAGE),
    // The image's own entrypoint would start a server; run the client script instead.
    entryPoint: ['sh', '-c'],
    command: [OWNER_BOOTSTRAP_SCRIPT],
    user: '70:70',
    environment: {
      DB_HOST: props.databaseHost,
      DB_NAME: props.databaseName,
      RDS_CA_URL: RDS_CA_BUNDLE_URL,
    },
    secrets: {
      MASTER_USER: ecs.Secret.fromSecretsManager(props.masterSecret, 'username'),
      MASTER_PASSWORD: ecs.Secret.fromSecretsManager(props.masterSecret, 'password'),
      OWNER_PASSWORD: ecs.Secret.fromSecretsManager(props.ownerSecret, 'password'),
    },
    logging: ecs.LogDrivers.awsLogs({
      logGroup: props.logGroup,
      streamPrefix: 'bootstrap-owner',
    }),
  });
  return taskDefinition;
}
