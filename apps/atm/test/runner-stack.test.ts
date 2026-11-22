import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getAtmConfig } from '../lib/atm-config';
import { EvidenceStack } from '../lib/evidence-stack';
import { LedgerStack } from '../lib/ledger-stack';
import { SecretsStack } from '../lib/secrets-stack';
import { RunnerStack, logRetention } from '../lib/runner-stack';

function build(env: 'staging' | 'production'): Template {
  const app = new cdk.App();
  const config = getAtmConfig(env);
  const cdkEnv = { account: '111111111111', region: 'us-east-2' };
  const evidence = new EvidenceStack(app, `atm-evidence-${env}`, {
    env: cdkEnv,
    config,
  });
  const ledger = new LedgerStack(app, `atm-ledger-${env}`, { env: cdkEnv, config });
  const secrets = new SecretsStack(app, `atm-secrets-${env}`, {
    env: cdkEnv,
    config,
  });
  const runner = new RunnerStack(app, `atm-runner-${env}`, {
    env: cdkEnv,
    config,
    evidenceBucket: evidence.bucket,
    findingsTable: ledger.table,
    secrets: [secrets.openai, secrets.tinker],
  });
  return Template.fromStack(runner);
}

describe('RunnerStack', () => {
  test('CodeBuild project is privileged, named, and uses a GitHub source without stored creds', () => {
    const template = build('staging');
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'atm-runner-staging',
      Environment: Match.objectLike({
        PrivilegedMode: true,
        ComputeType: 'BUILD_GENERAL1_MEDIUM',
      }),
      Source: Match.objectLike({ Type: 'GITHUB' }),
    });
    // No stored GitHub credential resource.
    template.resourceCountIs('AWS::CodeBuild::SourceCredential', 0);
  });

  test('log group retention equals the env config', () => {
    build('staging').hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30,
    });
    build('production').hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 365,
    });
  });

  test('service role grants no Resource:"*" on s3/dynamodb/secrets', () => {
    const template = build('staging');
    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{
        Action: string | string[];
        Resource: unknown;
      }>;
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const touchesData = actions.some((a) =>
          /^(s3|dynamodb|secretsmanager):/.test(a),
        );
        if (!touchesData) continue;
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        for (const r of resources) {
          expect(r).not.toBe('*');
        }
      }
    }
  });

  const statement = (template: Template, sid: string) =>
    Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>)
      .find((s) => s.Sid === sid);

  test('role is scoped to the findings table and its by-status GSI', () => {
    const template = build('staging');
    const ledger = statement(template, 'FindingsLedger');
    expect(ledger?.Action).toEqual(expect.arrayContaining(['dynamodb:Query', 'dynamodb:UpdateItem']));
    const resources = JSON.stringify(ledger?.Resource);
    expect(resources).toContain('FindingsTable');
    expect(resources).toContain('/index/by-status');
    expect(ledger?.Resource).toHaveLength(2);
  });

  test('role reaches only the evidence bucket and the two provider secrets, with no managed policies', () => {
    const template = build('staging');
    expect(JSON.stringify(statement(template, 'EvidenceObjects')?.Resource)).toContain('/*');
    expect(statement(template, 'EvidenceBucket')?.Resource).toBeDefined();
    expect(statement(template, 'ReadProviderSecrets')?.Resource).toHaveLength(2);
    const role = Object.values(template.findResources('AWS::IAM::Role'))[0];
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  });

  test('the GitHub credential placeholder is empty', () => {
    build('staging').hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({ Name: 'GITHUB_APP_TOKEN', Type: 'PLAINTEXT', Value: '' }),
        ]),
      }),
    });
  });

  test('production retains the log group; staging deletes it', () => {
    const prod = build('production').findResources('AWS::Logs::LogGroup');
    expect(Object.values(prod)[0].DeletionPolicy).toBe('Retain');
    const staging = build('staging').findResources('AWS::Logs::LogGroup');
    expect(Object.values(staging)[0].DeletionPolicy).toBe('Delete');
  });

  test('an unsupported retention is refused instead of silently shortened', () => {
    expect(() => logRetention(45)).toThrow(/unsupported logRetentionDays: 45/);
  });
});
