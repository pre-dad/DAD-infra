import { Template } from 'aws-cdk-lib/assertions';
import { BOOTSTRAP_CLIENT_IMAGE, OWNER_BOOTSTRAP_SCRIPT, RDS_CA_BUNDLE_URL } from '../lib/db-bootstrap';
import { buildGraph } from './helpers';

type Res = { Type: string; Properties: Record<string, any> };

/** Logical ids of resources of a type in a template. */
const ids = (t: Template, type: string): string[] => Object.keys(t.findResources(type));

describe('database owner bootstrap', () => {
  // The master credential is the most powerful one in the system. It must be reachable
  // only by the one-off bootstrap task, never through the proxy every app process uses.
  it('does not register the master secret with the RDS Proxy', () => {
    const t = Template.fromStack(buildGraph('staging').data);
    const masterId = ids(t, 'AWS::SecretsManager::Secret').find(
      (id) => !id.startsWith('LoginSecret'),
    );
    expect(masterId).toBeDefined();
    const proxy = Object.values(t.findResources('AWS::RDS::DBProxy') as Record<string, Res>)[0];
    const auth = JSON.stringify(proxy.Properties.Auth);
    expect(auth).not.toContain(masterId);
    // Every proxy auth entry is a per-login secret.
    for (const entry of proxy.Properties.Auth as Array<{ SecretArn: { Ref: string } }>) {
      expect(entry.SecretArn.Ref).toMatch(/^LoginSecret/);
    }
  });

  it('lets only the proxy and the bootstrap task reach the instance', () => {
    const t = Template.fromStack(buildGraph('staging').data);
    const ingress = Object.values(
      t.findResources('AWS::EC2::SecurityGroupIngress') as Record<string, Res>,
    ).filter((r) => JSON.stringify(r.Properties.GroupId).includes('DatabaseSg'));
    // CDK adds its own proxy->instance rule (on the instance's port attribute) next to
    // ours, so the proxy appears twice. What matters: every source is the proxy or the
    // bootstrap task, the bootstrap rule exists, and nothing is opened by CIDR.
    const source = (r: Res) => JSON.stringify(r.Properties.SourceSecurityGroupId);
    for (const r of ingress) {
      expect(source(r)).toMatch(/ProxySg|BootstrapSg/);
      expect(r.Properties.CidrIp).toBeUndefined();
      expect(r.Properties.IpProtocol).toBe('tcp');
      const port = JSON.stringify(r.Properties.FromPort);
      expect(port === '5432' || port.includes('Endpoint.Port')).toBe(true);
    }
    // A rule from a CIDR or a peer outside this stack can also be inlined on the
    // security group itself; there must be none.
    const dbSg = Object.entries(t.findResources('AWS::EC2::SecurityGroup') as Record<string, Res>).find(
      ([id]) => id.startsWith('DatabaseSg'),
    );
    expect(dbSg).toBeDefined();
    expect(dbSg![1].Properties.SecurityGroupIngress ?? []).toEqual([]);
    const bootstrap = ingress.filter((r) => source(r).includes('BootstrapSg'));
    expect(bootstrap).toHaveLength(1);
    expect([bootstrap[0].Properties.FromPort, bootstrap[0].Properties.ToPort]).toEqual([5432, 5432]);
    t.hasOutput('BootstrapSecurityGroupId', {});
  });

  it('is the only task definition that can read the master secret', () => {
    const g = buildGraph('staging');
    const readers: string[] = [];
    for (const stack of [g.services, g.maintenance]) {
      const defs = Template.fromStack(stack).findResources('AWS::ECS::TaskDefinition') as Record<string, Res>;
      for (const def of Object.values(defs)) {
        const secrets = JSON.stringify(def.Properties.ContainerDefinitions[0].Secrets ?? []);
        if (secrets.includes('PostgresSecret') || secrets.includes('rds/master') || secrets.includes('MasterSecret')) {
          readers.push(def.Properties.Family);
        }
      }
    }
    expect(readers).toEqual(['dad-maint-bootstrap-owner']);
  });

  it('runs a digest-pinned client as a non-root user, against the instance (not the proxy)', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    const def = Object.values(t.findResources('AWS::ECS::TaskDefinition') as Record<string, Res>).find(
      (d) => d.Properties.Family === 'dad-maint-bootstrap-owner',
    );
    expect(def).toBeDefined();
    const c = def!.Properties.ContainerDefinitions[0];
    expect(c.Image).toBe(BOOTSTRAP_CLIENT_IMAGE);
    expect(BOOTSTRAP_CLIENT_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(c.EntryPoint).toEqual(['sh', '-c']);
    expect(c.Command).toEqual([OWNER_BOOTSTRAP_SCRIPT]);
    expect(c.User).toBe('70:70');
    const env = Object.fromEntries((c.Environment as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]));
    expect(JSON.stringify(env.DB_HOST)).toMatch(/Postgres[0-9A-F]+EndpointAddress/);
    expect(JSON.stringify(env.DB_HOST)).not.toMatch(/Proxy/i);
    expect(env.DB_NAME).toBe('dad');
    expect(env.RDS_CA_URL).toBe(RDS_CA_BUNDLE_URL);
    expect(RDS_CA_BUNDLE_URL).toMatch(/^https:\/\//);
  });

  describe('script', () => {
    it('verifies the server certificate by default', () => {
      expect(OWNER_BOOTSTRAP_SCRIPT).toContain('PGSSLMODE="${PGSSLMODE:-verify-full}"');
      expect(OWNER_BOOTSTRAP_SCRIPT).toContain('export PGSSLROOTCERT=/tmp/rds-ca.pem');
    });

    it('reads passwords from the environment, never the command line or SQL text', () => {
      expect(OWNER_BOOTSTRAP_SCRIPT).toContain('\\getenv owner_pw OWNER_PASSWORD');
      expect(OWNER_BOOTSTRAP_SCRIPT).not.toMatch(/-v owner_pw/);
      expect(OWNER_BOOTSTRAP_SCRIPT).toContain("PASSWORD %L', :'owner_pw'");
      // The quoted heredoc keeps the shell from expanding anything inside the SQL.
      expect(OWNER_BOOTSTRAP_SCRIPT).toContain("<<'SQL'");
      expect(OWNER_BOOTSTRAP_SCRIPT).not.toMatch(/-c\s+["'].*PASSWORD/);
    });

    it('makes the master a member of owner before transferring the database', () => {
      const grant = OWNER_BOOTSTRAP_SCRIPT.indexOf('GRANT owner TO :"master";');
      const alter = OWNER_BOOTSTRAP_SCRIPT.indexOf('ALTER DATABASE :"db" OWNER TO owner;');
      expect(grant).toBeGreaterThan(0);
      expect(alter).toBeGreaterThan(grant);
    });

    it('stops on the first SQL error and requires every input', () => {
      expect(OWNER_BOOTSTRAP_SCRIPT).toContain('-v ON_ERROR_STOP=1');
      expect(OWNER_BOOTSTRAP_SCRIPT).toMatch(/^set -eu/);
      for (const v of ['DB_HOST', 'DB_NAME', 'MASTER_USER', 'MASTER_PASSWORD', 'OWNER_PASSWORD']) {
        expect(OWNER_BOOTSTRAP_SCRIPT).toContain(`"\${${v}:?}"`);
      }
    });
  });
});
