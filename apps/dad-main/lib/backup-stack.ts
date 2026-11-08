import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import { EnvConfig } from './config';

/** Retention of the daily recovery points, matching the RDS automated-backup window. */
export const DAILY_RETENTION_DAYS = 14;
/** Retention of the monthly recovery points. */
export const MONTHLY_RETENTION_DAYS = 365;

export const drVaultName = (env: string): string => `dad-${env}-dr-vault`;
export const backupRoleName = (env: string): string => `dad-${env}-backup`;

const vaultArn = (region: string, account: string, env: string): string =>
  `arn:aws:backup:${region}:${account}:backup-vault:${drVaultName(env)}`;

/** Props for {@link DrBackupVaultStack}. */
export interface DrBackupVaultStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
}

/**
 * The cross-region destination: a KMS-encrypted AWS Backup vault in
 * `config.crossRegionBackupRegion`. The stack must be pinned to that region; the vault and
 * its key are retained on stack deletion because they hold the only off-region copies.
 */
export class DrBackupVaultStack extends cdk.Stack {
  public readonly vault: backup.BackupVault;

  constructor(scope: Construct, id: string, props: DrBackupVaultStackProps) {
    super(scope, id, props);
    const { config } = props;

    const key = new kms.Key(this, 'DrBackupKey', {
      alias: `alias/dad-${config.env}-dr-backup`,
      description: `DAD ${config.env} cross-region database backup vault key.`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.vault = new backup.BackupVault(this, 'DrVault', {
      backupVaultName: drVaultName(config.env),
      encryptionKey: key,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}

/** Props for {@link BackupStack}. */
export interface BackupStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  /** The database to protect. */
  readonly database: rds.IDatabaseInstance;
  /** The destination region, from `config.crossRegionBackupRegion`. */
  readonly destinationRegion: string;
}

/**
 * AWS Backup plan for the production database. RDS automated backups cannot be replicated
 * across regions by CloudFormation, so AWS Backup takes its own snapshots and copies each
 * to the vault in {@link DrBackupVaultStack}.
 *
 *  - daily 05:00 UTC, kept 14 days in both regions
 *  - monthly (1st, 06:00 UTC), kept 12 months in both regions
 */
export class BackupStack extends cdk.Stack {
  public readonly plan: backup.BackupPlan;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: BackupStackProps) {
    super(scope, id, props);
    const { config, database, destinationRegion } = props;

    const key = new kms.Key(this, 'BackupKey', {
      alias: `alias/dad-${config.env}-backup`,
      description: `DAD ${config.env} database backup vault key.`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const vault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: `dad-${config.env}-vault`,
      encryptionKey: key,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const drVault = backup.BackupVault.fromBackupVaultArn(
      this,
      'DrVault',
      vaultArn(destinationRegion, this.account, config.env),
    );

    // Only AWS Backup may assume it. The AWS-managed backup service policy is the documented
    // minimum for backing up and copying RDS (restores are done by an operator, not this role); the selection below limits it to one database.
    this.role = new iam.Role(this, 'Role', {
      roleName: backupRoleName(config.env),
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSBackupServiceRolePolicyForBackup',
        ),
      ],
    });
    // Copying into the destination vault re-encrypts with its key (account-owned, so the
    // key policy's account delegation applies).
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UseDestinationVaultKey',
        actions: ['kms:Encrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*', 'kms:DescribeKey'],
        resources: [`arn:aws:kms:${destinationRegion}:${this.account}:key/*`],
      }),
    );

    this.plan = new backup.BackupPlan(this, 'Plan', {
      backupPlanName: `dad-${config.env}-database`,
      backupVault: vault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'daily',
          scheduleExpression: events.Schedule.cron({ minute: '0', hour: '5' }),
          deleteAfter: cdk.Duration.days(DAILY_RETENTION_DAYS),
          copyActions: [
            {
              destinationBackupVault: drVault,
              deleteAfter: cdk.Duration.days(DAILY_RETENTION_DAYS),
            },
          ],
        }),
        new backup.BackupPlanRule({
          ruleName: 'monthly',
          scheduleExpression: events.Schedule.cron({ minute: '0', hour: '6', day: '1' }),
          deleteAfter: cdk.Duration.days(MONTHLY_RETENTION_DAYS),
          copyActions: [
            {
              destinationBackupVault: drVault,
              deleteAfter: cdk.Duration.days(MONTHLY_RETENTION_DAYS),
            },
          ],
        }),
      ],
    });
    this.plan.addSelection('Database', {
      role: this.role,
      resources: [backup.BackupResource.fromRdsDatabaseInstance(database)],
      allowRestores: false,
    });
  }
}
