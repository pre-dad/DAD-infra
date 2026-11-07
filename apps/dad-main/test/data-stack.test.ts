import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildGraph } from './helpers';

describe('DataStack', () => {
  it('runs PostgreSQL engine version 16', () => {
    const t = Template.fromStack(buildGraph('staging').data);
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16'),
      StorageEncrypted: true,
    });
  });

  it('creates an RDS Proxy', () => {
    const t = Template.fromStack(buildGraph('staging').data);
    t.resourceCountIs('AWS::RDS::DBProxy', 1);
  });

  it('mints 13 secrets: 11 process logins + owner + master', () => {
    const t = Template.fromStack(buildGraph('staging').data);
    t.resourceCountIs('AWS::SecretsManager::Secret', 13);
  });

  it('multiAz is false for staging and true for production', () => {
    const staging = Template.fromStack(buildGraph('staging').data);
    staging.hasResourceProperties('AWS::RDS::DBInstance', { MultiAZ: false });

    const prod = Template.fromStack(buildGraph('production').data);
    prod.hasResourceProperties('AWS::RDS::DBInstance', { MultiAZ: true });
  });

  it('sizes the instance and storage per environment', () => {
    const staging = Template.fromStack(buildGraph('staging').data);
    staging.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.t4g.small',
      AllocatedStorage: '20',
      MaxAllocatedStorage: 200,
    });
    const prod = Template.fromStack(buildGraph('production').data);
    prod.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceClass: 'db.t3.large',
      AllocatedStorage: '50',
      MaxAllocatedStorage: 200,
    });
  });

  it('creates no Postgres roles (no custom resource for role creation)', () => {
    const t = Template.fromStack(buildGraph('staging').data);
    // The only resources are RDS, proxy, secrets, and their plumbing — never a
    // provisioning Lambda/custom resource that would create roles.
    const customResources = t.findResources('Custom::AWS');
    expect(Object.keys(customResources)).toHaveLength(0);
  });

  it('keeps the database private, backed up, and observable', () => {
    for (const name of ['staging', 'production'] as const) {
      const t = Template.fromStack(buildGraph(name).data);
      t.hasResourceProperties('AWS::RDS::DBInstance', {
        PubliclyAccessible: false,
        BackupRetentionPeriod: Match.anyValue(),
        EnablePerformanceInsights: true,
        EnableCloudwatchLogsExports: ['postgresql'],
      });
    }
  });

  it('retains and protects the production database, not staging', () => {
    const prod = Template.fromStack(buildGraph('production').data);
    prod.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Retain',
      Properties: { DeletionProtection: true, BackupRetentionPeriod: 14 },
    });
    const staging = Template.fromStack(buildGraph('staging').data);
    staging.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: false,
      BackupRetentionPeriod: 7,
    });
  });

  it('requires TLS on the proxy', () => {
    const t = Template.fromStack(buildGraph('staging').data);
    t.hasResourceProperties('AWS::RDS::DBProxy', { RequireTLS: true });
  });
});
