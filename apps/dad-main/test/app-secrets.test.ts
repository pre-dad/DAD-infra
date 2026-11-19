import { Template } from 'aws-cdk-lib/assertions';
import { buildGraph } from './helpers';

type Def = { Properties: { Family: string; ContainerDefinitions: Array<Record<string, any>> } };

/** family -> sorted secret env names, across the services and maintenance stacks. */
function secretsByFamily(): Record<string, string[]> {
  const g = buildGraph('staging');
  const out: Record<string, string[]> = {};
  for (const stack of [g.services, g.maintenance]) {
    const defs = Template.fromStack(stack).findResources('AWS::ECS::TaskDefinition') as Record<string, Def>;
    for (const def of Object.values(defs)) {
      const c = def.Properties.ContainerDefinitions[0];
      out[def.Properties.Family] = ((c.Secrets ?? []) as Array<{ Name: string }>).map((s) => s.Name).filter((n) => !n.endsWith('_DATABASE_PASSWORD')).sort();
    }
  }
  return out;
}

const MAIL_WORKER = [
  'DONOR_EMAIL_ENCRYPTION_KEY',
  'DONOR_EMAIL_FROM',
  'DONOR_SMTP_HOST',
  'DONOR_SMTP_PASSWORD',
  'DONOR_SMTP_PORT',
  'DONOR_SMTP_USERNAME',
];

describe('application secrets', () => {
  // Mirrors which variables docker-compose.prod.yml gives each process. Every process gets
  // exactly what it needs and nothing else: e.g. only Stripe-reading processes see the
  // Stripe key, and only the mail workers see the relay password. (Database passwords are
  // covered by database-credentials.test.ts.)
  it('injects exactly the secrets each process reads', () => {
    expect(secretsByFamily()).toEqual({
      'dad-api': [
        'DONOR_CONTENT_ENCRYPTION_KEY',
        'DONOR_EMAIL_ENCRYPTION_KEY',
        'DONOR_EMAIL_FROM',
        'DONOR_OIDC_APPLE_CLIENT_ID',
        'DONOR_OIDC_GOOGLE_CLIENT_ID',
        'DONOR_OIDC_MODE',
        'DONOR_OIDC_REQUIRE_NONCE',
        'DONOR_SMS_ACCOUNT_ID',
        'DONOR_SMS_AUTH_TOKEN',
        'DONOR_SMS_FROM',
        'DONOR_SMS_PROVIDER',
        'DONOR_SMTP_HOST',
        'DONOR_SMTP_PORT',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
      ],
      'dad-web': [
        'DONOR_OAUTH_APPLE_CLIENT_ID',
        'DONOR_OAUTH_APPLE_CLIENT_SECRET',
        'DONOR_OAUTH_GOOGLE_CLIENT_ID',
        'DONOR_OAUTH_GOOGLE_CLIENT_SECRET',
      ],
      'dad-nginx': ['INGRESS_TLS_FULLCHAIN', 'INGRESS_TLS_PRIVKEY'],
      'dad-stripe-worker': ['STRIPE_SECRET_KEY'],
      'dad-projection-worker': [],
      'dad-login-email-worker': MAIL_WORKER,
      'dad-email-change-worker': MAIL_WORKER,
      'dad-message-worker': MAIL_WORKER,
      'dad-push-worker': [],
      'dad-maint-migrate': [],
      'dad-maint-provision-roles': [],
      'dad-maint-staff': [],
      'dad-maint-rekey': ['DONOR_CONTENT_ENCRYPTION_KEY', 'DONOR_EMAIL_ENCRYPTION_KEY'],
      'dad-maint-monitor': [],
      'dad-maint-reconcile': ['STRIPE_SECRET_KEY'],
      'dad-maint-bootstrap-owner': ['MASTER_PASSWORD', 'MASTER_USER', 'OWNER_PASSWORD'],
    });
  });

  it('never puts a secret value in a plain environment variable', () => {
    const g = buildGraph('staging');
    const secretNames = new Set([
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'DONOR_EMAIL_ENCRYPTION_KEY',
      'DONOR_CONTENT_ENCRYPTION_KEY',
      'DONOR_SMTP_PASSWORD',
      'DONOR_SMTP_USERNAME',
      'INGRESS_TLS_FULLCHAIN',
      'INGRESS_TLS_PRIVKEY',
      'MASTER_PASSWORD',
      'OWNER_PASSWORD',
      'DONOR_SMS_AUTH_TOKEN',
      'DONOR_OAUTH_APPLE_CLIENT_SECRET',
      'DONOR_OAUTH_GOOGLE_CLIENT_SECRET',
    ]);
    const offenders: string[] = [];
    for (const stack of [g.services, g.maintenance]) {
      const defs = Template.fromStack(stack).findResources('AWS::ECS::TaskDefinition') as Record<string, Def>;
      for (const def of Object.values(defs)) {
        for (const e of (def.Properties.ContainerDefinitions[0].Environment ?? []) as Array<{ Name: string }>) {
          if (secretNames.has(e.Name)) offenders.push(`${def.Properties.Family}:${e.Name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads each secret field from the right Secrets Manager secret', () => {
    const t = Template.fromStack(buildGraph('staging').services);
    const defs = t.findResources('AWS::ECS::TaskDefinition') as Record<string, Def>;
    const api = Object.values(defs).find((d) => d.Properties.Family === 'dad-api');
    const byName = Object.fromEntries(
      (api?.Properties.ContainerDefinitions[0].Secrets as Array<{ Name: string; ValueFrom: unknown }>).map((s) => [
        s.Name,
        JSON.stringify(s.ValueFrom),
      ]),
    );
    // ValueFrom is "<secret arn>:<json field>::"; the export name identifies the stack.
    expect(byName.STRIPE_WEBHOOK_SECRET).toMatch(/dad-app-secrets-staging.*StripeSecret.*:STRIPE_WEBHOOK_SECRET::/);
    expect(byName.DONOR_CONTENT_ENCRYPTION_KEY).toMatch(
      /dad-app-secrets-staging.*EncryptionSecret.*:DONOR_CONTENT_ENCRYPTION_KEY::/,
    );
    expect(byName.DONOR_SMTP_HOST).toMatch(/dad-ses-staging.*SmtpSecret.*:DONOR_SMTP_HOST::/);
    expect(byName.DONOR_SMS_AUTH_TOKEN).toMatch(/dad-app-secrets-staging.*SignInSecret.*:DONOR_SMS_AUTH_TOKEN::/);
    const web = Object.values(defs).find((d) => d.Properties.Family === 'dad-web');
    const webByName = Object.fromEntries(
      (web?.Properties.ContainerDefinitions[0].Secrets as Array<{ Name: string; ValueFrom: unknown }>).map((s) => [
        s.Name,
        JSON.stringify(s.ValueFrom),
      ]),
    );
    expect(webByName.DONOR_OAUTH_APPLE_CLIENT_SECRET).toMatch(
      /dad-app-secrets-staging.*WebOAuthSecret.*:DONOR_OAUTH_APPLE_CLIENT_SECRET::/,
    );
  });

  // The operator puts the real values in after the first deploy (docs/bootstrap.md). A
  // value in the template would be reapplied on any stack update that touches the secret.
  it('creates the secrets with empty fields and no value in the template, retained on delete', () => {
    for (const env of ['staging', 'production'] as const) {
      const t = Template.fromStack(buildGraph(env).appSecrets);
      const secrets = t.findResources('AWS::SecretsManager::Secret') as Record<string, any>;
      const byName: Record<string, any> = Object.fromEntries(
        Object.values(secrets).map((s) => [s.Properties.Name, s]),
      );
      expect(Object.keys(byName).sort()).toEqual([
        `dad/${env}/app/encryption`,
        `dad/${env}/app/sign-in`,
        `dad/${env}/app/stripe`,
        `dad/${env}/app/web-oauth`,
        `dad/${env}/ingress/tls`,
      ]);
      for (const s of Object.values(byName) as any[]) {
        expect(s.Properties.SecretString).toBeUndefined();
        expect(s.DeletionPolicy).toBe('Retain');
        expect(s.UpdateReplacePolicy).toBe('Retain');
        const fields = JSON.parse(s.Properties.GenerateSecretString.SecretStringTemplate);
        expect(Object.values(fields).every((v) => v === '')).toBe(true);
      }
    }
  });
});
