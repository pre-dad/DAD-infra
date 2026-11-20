import { Template } from 'aws-cdk-lib/assertions';
import { buildGraph } from './helpers';
import { OWNER_LOGIN, PROCESS_LOGINS, passwordVariable, buildPasswordlessDatabaseUrl } from '../lib/db-url';

type Json = Record<string, any>;

interface Task {
  family: string;
  env: Record<string, unknown>;
  secrets: Record<string, string>;
  executionRoleId: string;
  template: Template;
}

/** Every task definition in the services and maintenance stacks, with its container. */
function tasks(envName: 'staging' | 'production'): Task[] {
  const g = buildGraph(envName);
  const out: Task[] = [];
  for (const stack of [g.services, g.maintenance]) {
    const template = Template.fromStack(stack);
    for (const def of Object.values(template.findResources('AWS::ECS::TaskDefinition')) as Json[]) {
      const c = def.Properties.ContainerDefinitions[0];
      out.push({
        family: def.Properties.Family,
        env: Object.fromEntries((c.Environment ?? []).map((e: Json) => [e.Name, e.Value])),
        secrets: Object.fromEntries(
          (c.Secrets ?? []).map((s: Json) => [s.Name, JSON.stringify(s.ValueFrom)]),
        ),
        executionRoleId: def.Properties.ExecutionRoleArn['Fn::GetAtt'][0],
        template,
      });
    }
  }
  return out;
}

const dbVars = (m: Record<string, unknown>) => Object.keys(m).filter((k) => /DATABASE_(URL|PASSWORD)$/.test(k));

describe.each(['staging', 'production'] as const)('database credentials (%s)', (envName) => {
  // web, nginx and the owner bootstrap do not use the application database logins.
  const all = tasks(envName).filter((t) => Object.keys(t.env).some((k) => k.endsWith('_DATABASE_URL')));

  it('covers the services, workers and maintenance tasks', () => {
    expect(all.map((t) => t.family).sort()).toEqual(
      expect.arrayContaining([
        'dad-api',
        'dad-maint-migrate',
        'dad-maint-provision-roles',
        'dad-maint-reconcile',
      ]),
    );
  });

  it('keeps passwords and dynamic references out of every environment value', () => {
    for (const t of tasks(envName)) {
      for (const [name, value] of Object.entries(t.env)) {
        const v = JSON.stringify(value);
        expect(`${t.family} ${name} ${v}`).not.toMatch(/resolve:secretsmanager/);
        expect(`${t.family} ${name} ${v}`).not.toMatch(/PASSWORD/i);
        if (name.endsWith('_DATABASE_URL')) {
          expect(v).toMatch(/postgresql:\/\/[a-z_]+@/);
        }
      }
    }
  });

  it('injects each database URL variable with its own _PASSWORD secret', () => {
    for (const t of all) {
      const urls = Object.keys(t.env).filter((k) => k.endsWith('_DATABASE_URL'));
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        const pw = passwordVariable(url);
        expect(t.secrets[pw]).toBeDefined();
        expect(t.secrets[pw]).toContain(':password::');
      }
      // No password secret without a matching URL.
      const pwVars = dbVars(t.secrets);
      expect(pwVars.sort()).toEqual(urls.map(passwordVariable).sort());
    }
  });

  it('gives each task exactly its logins: the owner for migrate, all twelve for provision', () => {
    const by = Object.fromEntries(all.map((t) => [t.family, Object.keys(t.env).filter((k) => k.endsWith('_DATABASE_URL')).sort()]));
    expect(by['dad-maint-migrate']).toEqual([OWNER_LOGIN.envVar]);
    expect(by['dad-maint-provision-roles']).toEqual(
      [OWNER_LOGIN.envVar, ...Object.values(PROCESS_LOGINS).map((p) => p.envVar)].sort(),
    );
    expect(by['dad-api']).toEqual([PROCESS_LOGINS.api.envVar]);
    expect(by['dad-maint-reconcile']).toEqual([PROCESS_LOGINS.reconcile.envVar]);
  });

  it('scopes each execution role to exactly the secrets its task injects', () => {
    for (const t of all) {
      const policies = Object.values(t.template.findResources('AWS::IAM::Policy')) as Json[];
      const mine = policies.filter((p) =>
        (p.Properties.Roles ?? []).some((r: Json) => r.Ref === t.executionRoleId),
      );
      const granted = new Set<string>();
      for (const p of mine) {
        for (const st of p.Properties.PolicyDocument.Statement as Json[]) {
          const actions = ([] as string[]).concat(st.Action);
          if (!actions.some((a) => a.startsWith('secretsmanager:'))) continue;
          expect(actions.sort()).toEqual(['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
          for (const r of ([] as unknown[]).concat(st.Resource)) granted.add(JSON.stringify(r));
        }
      }
      // The secret ARN is the valueFrom prefix; every secret is referenced by one ARN.
      const injected = new Set(
        Object.values(t.secrets).map((v) => JSON.stringify(JSON.parse(v)['Fn::Join']?.[1]?.[0] ?? JSON.parse(v))),
      );
      expect([...granted].sort()).toEqual([...injected].sort());
    }
  });
});

describe('buildPasswordlessDatabaseUrl', () => {
  it('keeps the pooler and TLS query string and carries no password', () => {
    expect(
      buildPasswordlessDatabaseUrl({ login: 'dad_api_login', proxyEndpoint: 'proxy.example', db: 'dad' }),
    ).toBe('postgresql://dad_api_login@proxy.example:5432/dad?default_query_exec_mode=exec&sslmode=verify-full');
  });

  it('derives the password variable from the URL variable', () => {
    expect(passwordVariable('DONOR_API_DATABASE_URL')).toBe('DONOR_API_DATABASE_PASSWORD');
    expect(() => passwordVariable('DONOR_API_DATABASE')).toThrow();
  });
});
