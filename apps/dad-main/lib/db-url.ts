/**
 * PostgreSQL connection-URL builder and the per-process login → env-var map.
 *
 * Per .env.database.example and docs/operations.md:
 *   - Every process connects through the RDS Proxy (transaction-mode pooler)
 *     on port 5432, which requires `default_query_exec_mode=exec`.
 *   - TLS is enforced end-to-end with `sslmode=verify-full`.
 *   - There are 11 per-process login roles plus the owner role (used only by
 *     migrate / provision-roles via DONOR_GO_DATABASE_URL).
 *
 * CDK does NOT create these Postgres roles — the `migrate` and `provision-roles`
 * maintenance tasks do. This module only produces the connection strings and the
 * canonical login↔env-var mapping that later stacks wire into task definitions.
 */

/** Inputs needed to build one per-process database URL. */
export interface DatabaseUrlParts {
  /** PostgreSQL role / login name (e.g. `dad_api_login`). */
  readonly login: string;
  /** Role password (typically sourced from a Secrets Manager secret at deploy). */
  readonly password: string;
  /** RDS Proxy endpoint host (no scheme, no port). */
  readonly proxyEndpoint: string;
  /** Database name (default `dad`). */
  readonly db: string;
}

/**
 * The fixed query string every DAD connection must carry.
 *
 * `default_query_exec_mode=exec` is required because the RDS Proxy runs in
 * transaction pooling mode; `sslmode=verify-full` enforces TLS with hostname
 * verification.
 */
export const DB_URL_QUERY_STRING =
  '?default_query_exec_mode=exec&sslmode=verify-full';

/**
 * Build a per-process PostgreSQL connection URL pointing at the RDS Proxy.
 *
 * Shape:
 *   postgresql://<login>:<password>@<proxyEndpoint>:5432/<db>?default_query_exec_mode=exec&sslmode=verify-full
 */
export function buildDatabaseUrl(parts: DatabaseUrlParts): string {
  const { login, password, proxyEndpoint, db } = parts;
  return `postgresql://${login}:${password}@${proxyEndpoint}:5432/${db}${DB_URL_QUERY_STRING}`;
}

/**
 * The same URL without a password: `postgresql://<login>@<proxyEndpoint>:5432/<db>?...`.
 *
 * DAD-Main accepts this form together with `<PREFIX>_PASSWORD` (see
 * {@link passwordVariable}), so the password reaches the process as an ECS secret and
 * never sits in a task-definition `environment` value. The URL, rather than separate
 * HOST/NAME/USER parts, keeps `default_query_exec_mode=exec`, which the RDS Proxy needs and
 * the parts form cannot express.
 */
export function buildPasswordlessDatabaseUrl(
  parts: Omit<DatabaseUrlParts, 'password'>,
): string {
  const { login, proxyEndpoint, db } = parts;
  return `postgresql://${login}@${proxyEndpoint}:5432/${db}${DB_URL_QUERY_STRING}`;
}

/** The env var carrying the password for a `..._DATABASE_URL` variable. */
export function passwordVariable(urlEnvVar: string): string {
  if (!urlEnvVar.endsWith('_URL')) {
    throw new Error(`not a database URL variable: ${urlEnvVar}`);
  }
  return `${urlEnvVar.slice(0, -'_URL'.length)}_PASSWORD`;
}

/** One per-process database role and the env var its URL is injected as. */
export interface ProcessLogin {
  /** PostgreSQL login/role name. */
  readonly login: string;
  /** Environment variable the process reads its connection URL from. */
  readonly envVar: string;
}

/**
 * All 11 least-privilege per-process logins, keyed by a short process id,
 * each mapped to its login name and the DONOR_* env var the process reads.
 *
 * Note: the owner login (DONOR_GO_DATABASE_URL) is intentionally NOT in this
 * map — see {@link OWNER_LOGIN}. The owner URL is used only by the migrate and
 * provision-roles maintenance tasks, never by a long-running service.
 */
export const PROCESS_LOGINS: Record<string, ProcessLogin> = {
  api: { login: 'dad_api_login', envVar: 'DONOR_API_DATABASE_URL' },
  'worker-stripe': {
    login: 'dad_worker_stripe_login',
    envVar: 'DONOR_WORKER_STRIPE_DATABASE_URL',
  },
  'worker-projections': {
    login: 'dad_worker_projections_login',
    envVar: 'DONOR_WORKER_PROJECTIONS_DATABASE_URL',
  },
  'worker-login-email': {
    login: 'dad_worker_login_email_login',
    envVar: 'DONOR_WORKER_LOGIN_EMAIL_DATABASE_URL',
  },
  'worker-email-changes': {
    login: 'dad_worker_email_changes_login',
    envVar: 'DONOR_WORKER_EMAIL_CHANGES_DATABASE_URL',
  },
  'worker-messages': {
    login: 'dad_worker_messages_login',
    envVar: 'DONOR_WORKER_MESSAGES_DATABASE_URL',
  },
  'worker-push': {
    login: 'dad_worker_push_login',
    envVar: 'DONOR_WORKER_PUSH_DATABASE_URL',
  },
  monitor: { login: 'dad_monitor_login', envVar: 'DONOR_MONITOR_DATABASE_URL' },
  staff: {
    login: 'dad_staff_cli_login',
    envVar: 'DONOR_STAFF_CLI_DATABASE_URL',
  },
  rekey: { login: 'dad_rekey_login', envVar: 'DONOR_REKEY_DATABASE_URL' },
  reconcile: {
    login: 'dad_reconcile_login',
    envVar: 'DONOR_RECONCILE_DATABASE_URL',
  },
};

/**
 * The owner / bootstrap login. Used only by `migrate` and `provision-roles`
 * (via DONOR_GO_DATABASE_URL); it creates and manages the per-process roles.
 */
export const OWNER_LOGIN: ProcessLogin = {
  login: 'owner',
  envVar: 'DONOR_GO_DATABASE_URL',
};

/** Convenience: every login CDK must mint a secret for (11 processes + owner). */
export const ALL_LOGINS: ReadonlyArray<ProcessLogin> = [
  ...Object.values(PROCESS_LOGINS),
  OWNER_LOGIN,
];
