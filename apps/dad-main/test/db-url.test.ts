import {
  buildPasswordlessDatabaseUrl,
  DB_URL_QUERY_STRING,
  PROCESS_LOGINS,
  OWNER_LOGIN,
  ALL_LOGINS,
} from '../lib/db-url';

describe('buildPasswordlessDatabaseUrl', () => {
  it('always carries the transaction-pooler + verify-full query string', () => {
    const url = buildPasswordlessDatabaseUrl({
      login: 'x',
      proxyEndpoint: 'host',
      db: 'dad',
    });
    expect(url.endsWith(DB_URL_QUERY_STRING)).toBe(true);
    expect(DB_URL_QUERY_STRING).toBe(
      '?default_query_exec_mode=exec&sslmode=verify-full',
    );
    expect(url).toContain(':5432/');
  });
});

describe('PROCESS_LOGINS', () => {
  it('covers exactly the 11 per-process logins with their env vars', () => {
    const expected: Record<string, string> = {
      dad_api_login: 'DONOR_API_DATABASE_URL',
      dad_worker_stripe_login: 'DONOR_WORKER_STRIPE_DATABASE_URL',
      dad_worker_projections_login: 'DONOR_WORKER_PROJECTIONS_DATABASE_URL',
      dad_worker_login_email_login: 'DONOR_WORKER_LOGIN_EMAIL_DATABASE_URL',
      dad_worker_email_changes_login: 'DONOR_WORKER_EMAIL_CHANGES_DATABASE_URL',
      dad_worker_messages_login: 'DONOR_WORKER_MESSAGES_DATABASE_URL',
      dad_worker_push_login: 'DONOR_WORKER_PUSH_DATABASE_URL',
      dad_monitor_login: 'DONOR_MONITOR_DATABASE_URL',
      dad_staff_cli_login: 'DONOR_STAFF_CLI_DATABASE_URL',
      dad_rekey_login: 'DONOR_REKEY_DATABASE_URL',
      dad_reconcile_login: 'DONOR_RECONCILE_DATABASE_URL',
    };

    const actual: Record<string, string> = {};
    for (const p of Object.values(PROCESS_LOGINS)) {
      actual[p.login] = p.envVar;
    }

    expect(Object.keys(PROCESS_LOGINS)).toHaveLength(11);
    expect(actual).toEqual(expected);
  });

  it('maps the owner login to DONOR_GO_DATABASE_URL', () => {
    expect(OWNER_LOGIN.login).toBe('owner');
    expect(OWNER_LOGIN.envVar).toBe('DONOR_GO_DATABASE_URL');
  });

  it('ALL_LOGINS = 11 process logins + owner, with unique env vars', () => {
    expect(ALL_LOGINS).toHaveLength(12);
    const envVars = ALL_LOGINS.map((l) => l.envVar);
    expect(new Set(envVars).size).toBe(12);
    expect(envVars).toContain('DONOR_GO_DATABASE_URL');
  });
});
