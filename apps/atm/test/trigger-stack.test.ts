import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getAtmConfig } from '../lib/atm-config';
import { EvidenceStack } from '../lib/evidence-stack';
import { LedgerStack } from '../lib/ledger-stack';
import { SecretsStack } from '../lib/secrets-stack';
import { RunnerStack } from '../lib/runner-stack';
import { TriggerStack } from '../lib/trigger-stack';

function build(env: 'staging' | 'production'): {
  stacks: Record<string, cdk.Stack>;
  trigger: Template;
  runner: Template;
} {
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
  const trigger = new TriggerStack(app, `atm-trigger-${env}`, {
    env: cdkEnv,
    config,
    project: runner.project,
  });
  return {
    stacks: { evidence, ledger, secrets, runner, trigger },
    trigger: Template.fromStack(trigger),
    runner: Template.fromStack(runner),
  };
}

describe('TriggerStack', () => {
  test('the scheduler target is the runner project', () => {
    for (const env of ['staging', 'production'] as const) {
      const { trigger, runner } = build(env);
      const [schedule] = Object.values(trigger.findResources('AWS::Scheduler::Schedule'));
      const imported = schedule.Properties.Target.Arn['Fn::ImportValue'] as string;
      const projectArn = Object.values(runner.findOutputs('*')).find(
        (o) => o.Export?.Name === imported,
      );
      expect(projectArn).toBeDefined();
      expect(JSON.stringify(projectArn?.Value)).toContain('RunnerProject');
      expect(schedule.Properties.Name).toBe(`atm-nightly-${env}`);
    }
  });

  test('a failing start is retried twice within an hour, not for a day', () => {
    const { trigger } = build('staging');
    trigger.hasResourceProperties('AWS::Scheduler::Schedule', {
      Target: Match.objectLike({
        RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
      }),
    });
  });

  test('the only way to start a run is the scheduler role, limited to StartBuild on the project', () => {
    for (const env of ['staging', 'production'] as const) {
      const { trigger } = build(env);
      const roles = trigger.findResources('AWS::IAM::Role');
      expect(Object.keys(roles)).toHaveLength(1);
      trigger.hasResourceProperties('AWS::IAM::Role', {
        RoleName: `atm-scheduler-${env}`,
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: 'sts:AssumeRole',
              Principal: { Service: 'scheduler.amazonaws.com' },
            }),
          ],
        },
      });
      const statements = Object.values(trigger.findResources('AWS::IAM::Policy')).flatMap(
        (p) => p.Properties.PolicyDocument.Statement as Array<{ Action: unknown }>,
      );
      expect(statements).toHaveLength(1);
      expect(statements[0].Action).toBe('codebuild:StartBuild');
    }
  });

  test('the scheduler role trusts only this account and this stack\'s schedule', () => {
    for (const env of ['staging', 'production'] as const) {
      const { trigger } = build(env);
      trigger.hasResourceProperties('AWS::IAM::Role', {
        RoleName: `atm-scheduler-${env}`,
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Condition: {
                StringEquals: { 'aws:SourceAccount': '111111111111' },
                ArnEquals: {
                  'aws:SourceArn': `arn:aws:scheduler:us-east-2:111111111111:schedule/default/atm-nightly-${env}`,
                },
              },
            }),
          ],
        },
      });
    }
  });

  // DAD-Main CI deliberately cannot start a run yet (see trigger-stack.ts), and an
  // account has exactly one GitHub OIDC provider, which apps/dad-main owns. Two stacks
  // creating it would fail the second deploy.
  test('creates no GitHub OIDC provider and no web-identity role in any atm stack', () => {
    const offenders: string[] = [];
    for (const env of ['staging', 'production'] as const) {
      const { stacks } = build(env);
      for (const [name, stack] of Object.entries(stacks)) {
        const t = Template.fromStack(stack);
        if (Object.keys(t.findResources('Custom::AWSCDKOpenIdConnectProvider')).length > 0) {
          offenders.push(`${name} (${env}): creates an OIDC provider`);
        }
        if (JSON.stringify(t.toJSON()).includes('sts:AssumeRoleWithWebIdentity')) {
          offenders.push(`${name} (${env}): trusts web identities`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
