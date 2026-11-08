import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib';
import { buildGraph } from './helpers';
import { getConfig } from '../lib/config';
import { DAILY_RETENTION_DAYS, MONTHLY_RETENTION_DAYS } from '../lib/backup-stack';

const stackNames = (g: ReturnType<typeof buildGraph>) =>
  g.app.node.children.filter(cdk.Stack.isStack);

const services = (name: 'staging' | 'production') =>
  Template.fromStack(buildGraph(name).services);

describe('task floors', () => {
  it('production keeps three tasks per request-path service, with headroom above the floor', () => {
    const c = getConfig('production');
    expect(c.desiredCounts).toMatchObject({ api: 3, web: 3, nginx: 3 });
    for (const svc of ['api', 'web', 'nginx'] as const) {
      expect(c.autoscaling[svc].maxCount).toBeGreaterThan(3);
    }
    const t = services('production');
    const floors = Object.values(t.findResources('AWS::ApplicationAutoScaling::ScalableTarget'));
    expect(floors.map((r) => r.Properties.MinCapacity)).toEqual([3, 3, 3]);
  });

  it('production rebalances the three services across AZs', () => {
    const t = services('production');
    const rebalanced = Object.values(t.findResources('AWS::ECS::Service')).filter(
      (r) => r.Properties.AvailabilityZoneRebalancing === 'ENABLED',
    );
    expect(rebalanced).toHaveLength(3);
  });

  it('staging stays at one task each with no rebalancing', () => {
    const c = getConfig('staging');
    expect(c.desiredCounts).toEqual({ api: 1, web: 1, nginx: 1, workers: 1 });
    const t = services('staging');
    const withRebalancing = Object.values(t.findResources('AWS::ECS::Service')).filter(
      (r) => 'AvailabilityZoneRebalancing' in r.Properties,
    );
    expect(withRebalancing).toHaveLength(0);
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 1 });
  });
});

describe('termination protection', () => {
  it('is on for every production stack and off for every staging stack', () => {
    const prod = stackNames(buildGraph('production'));
    expect(prod.length).toBeGreaterThan(10);
    expect(prod.filter((s) => !s.terminationProtection)).toEqual([]);
    const staging = stackNames(buildGraph('staging'));
    expect(staging.filter((s) => s.terminationProtection)).toEqual([]);
  });
});

describe('retained secrets', () => {
  const retention = (t: Template) =>
    Object.values(t.findResources('AWS::SecretsManager::Secret')).map(
      (r) => r.DeletionPolicy ?? 'Delete',
    );

  it('production retains the master, every login and the SMTP secret', () => {
    const g = buildGraph('production');
    const data = retention(Template.fromStack(g.data));
    expect(data).toHaveLength(13);
    expect(new Set(data)).toEqual(new Set(['Retain']));
    expect(retention(Template.fromStack(g.ses))).toEqual(['Retain']);
  });

  it('staging still destroys them', () => {
    const g = buildGraph('staging');
    expect(new Set(retention(Template.fromStack(g.data)))).toEqual(new Set(['Delete']));
    expect(retention(Template.fromStack(g.ses))).toEqual(['Delete']);
  });
});

describe('cross-region database backups', () => {
  it('production copies to a vault in the destination region', () => {
    const g = buildGraph('production');
    expect(g.drVault?.region).toBe('us-west-2');
    expect(g.backup?.region).toBe('us-east-2');
    expect(g.backup?.dependencies).toContain(g.drVault);

    const dr = Template.fromStack(g.drVault!);
    dr.hasResource('AWS::Backup::BackupVault', {
      DeletionPolicy: 'Retain',
      Properties: { BackupVaultName: 'dad-production-dr-vault', EncryptionKeyArn: Match.anyValue() },
    });
    dr.hasResource('AWS::KMS::Key', {
      DeletionPolicy: 'Retain',
      Properties: { EnableKeyRotation: true },
    });
  });

  it('runs a daily and a monthly rule with matching copy retention', () => {
    const t = Template.fromStack(buildGraph('production').backup!);
    expect(DAILY_RETENTION_DAYS).toBe(14);
    expect(MONTHLY_RETENTION_DAYS).toBe(365);
    t.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: {
        BackupPlanRule: [
          Match.objectLike({
            RuleName: 'daily',
            Lifecycle: { DeleteAfterDays: 14 },
            CopyActions: [
              Match.objectLike({
                Lifecycle: { DeleteAfterDays: 14 },
                DestinationBackupVaultArn: Match.stringLikeRegexp(
                  'us-west-2:.*:backup-vault:dad-production-dr-vault$',
                ),
              }),
            ],
          }),
          Match.objectLike({
            RuleName: 'monthly',
            Lifecycle: { DeleteAfterDays: 365 },
            CopyActions: [Match.objectLike({ Lifecycle: { DeleteAfterDays: 365 } })],
          }),
        ],
      },
    });
  });

  it('selects only the database and uses a role only AWS Backup can assume', () => {
    const t = Template.fromStack(buildGraph('production').backup!);
    t.resourceCountIs('AWS::Backup::BackupSelection', 1);
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'dad-production-backup',
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({ Principal: { Service: 'backup.amazonaws.com' } })],
      },
    });
    const selection = Object.values(t.findResources('AWS::Backup::BackupSelection'))[0];
    expect(selection.Properties.BackupSelection.Resources).toHaveLength(1);
  });

  it('is absent from staging, which creates no backup stacks', () => {
    const g = buildGraph('staging');
    expect(g.backup).toBeUndefined();
    expect(g.drVault).toBeUndefined();
    expect(getConfig('staging').crossRegionBackupRegion).toBeUndefined();
    expect(stackNames(g).map((s) => s.stackName).filter((n) => /backup|dr-vault/.test(n))).toEqual([]);
  });

  it('keeps native automated backups in the source region', () => {
    const t = Template.fromStack(buildGraph('production').data);
    t.hasResourceProperties('AWS::RDS::DBInstance', { BackupRetentionPeriod: 14, MultiAZ: true });
  });
});
