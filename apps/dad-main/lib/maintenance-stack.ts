import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EnvConfig } from './config';
import { toRetentionDays } from './ecs-cluster-stack';
import { imageTagFor } from './image-tag';
import { ownerBootstrapTaskDefinition } from './db-bootstrap';
import {
  PROCESS_LOGINS,
  OWNER_LOGIN,
  ProcessLogin,
} from './db-url';
import {
  AppSecrets,
  databaseConnection,
  DatabaseConnection,
  secretFields,
  TaskFactory,
} from './task-factory';

/** Props for {@link MaintenanceStack}. */
export interface MaintenanceStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly vpc: ec2.IVpc;
  readonly computeSubnets: ec2.SubnetSelection;
  readonly cluster: ecs.ICluster;
  readonly repositories: Record<'api' | 'web' | 'nginx', ecr.IRepository>;
  readonly proxyEndpoint: string;
  readonly loginSecrets: Record<string, secretsmanager.ISecret>;
  readonly workersSecurityGroup: ec2.ISecurityGroup;
  /** Application secrets (rekey reads the encryption keys, reconcile the Stripe key). */
  readonly appSecrets: AppSecrets;
  /** RDS master secret (`username`, `password`); read only by the owner bootstrap task. */
  readonly masterSecret: secretsmanager.ISecret;
  /** RDS instance endpoint address, which the owner bootstrap connects to directly. */
  readonly databaseHost: string;
  /** SNS topic that receives the reconcile alarms. */
  readonly alarmTopic: sns.ITopic;
}

/**
 * MaintenanceStack.
 *
 * run-task task definitions for migrate, provision-roles, staff, rekey, monitor and
 * bootstrap-owner (six one-off tasks), plus a reconcile task definition driven by
 * an EventBridge Scheduler cron (~00:30 America/New_York) as a Fargate
 * run-task, with a CloudWatch alarm on a non-zero reconcile exit wired to SNS.
 *
 * These are task definitions only — CDK never runs them. The operator invokes
 * them with DAD-Main's scripts/run-task.sh (bootstrap-owner once, then migrate →
 * provision-roles; see docs/bootstrap.md).
 */
export class MaintenanceStack extends cdk.Stack {
  public readonly taskDefinitions: Record<string, ecs.FargateTaskDefinition>;
  public readonly reconcileSchedule: scheduler.CfnSchedule;
  public readonly reconcileExitAlarm: cloudwatch.Alarm;
  public readonly reconcileFailedToRunRule: events.Rule;

  constructor(scope: Construct, id: string, props: MaintenanceStackProps) {
    super(scope, id, props);

    const {
      config,
      vpc,
      computeSubnets,
      cluster,
      repositories,
      proxyEndpoint,
      loginSecrets,
      workersSecurityGroup,
      appSecrets,
      masterSecret,
      databaseHost,
      alarmTopic,
    } = props;

    const factory = new TaskFactory(this, repositories, imageTagFor(this, config));
    this.taskDefinitions = {};

    const log = new logs.LogGroup(this, 'MaintenanceLogs', {
      logGroupName: `/dad/${config.env}/maintenance`,
      retention: toRetentionDays(config.logRetentionDays),
      removalPolicy: config.deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const db = (login: ProcessLogin) =>
      databaseConnection(login, loginSecrets[login.login], proxyEndpoint, config.dbName);
    const merge = (...parts: DatabaseConnection[]): DatabaseConnection => ({
      environment: Object.assign({}, ...parts.map((p) => p.environment)),
      secrets: Object.assign({}, ...parts.map((p) => p.secrets)),
    });

    // provision-roles: the owner plus every per-process login.
    const provisionDb = merge(db(OWNER_LOGIN), ...Object.values(PROCESS_LOGINS).map(db));

    const defineTask = (
      taskId: string,
      command: string[],
      environment: Record<string, string>,
      secrets: Record<string, ecs.Secret> = {},
    ): ecs.FargateTaskDefinition => {
      const { taskDefinition } = factory.build({
        id: `maint-${taskId}`,
        image: 'api',
        size: config.taskSizes.worker,
        command,
        environment,
        secrets,
        logGroup: log,
        logStreamPrefix: taskId,
      });
      this.taskDefinitions[taskId] = taskDefinition;
      return taskDefinition;
    };

    const ownerDb = db(OWNER_LOGIN);
    defineTask('migrate', ['migrate'], ownerDb.environment, ownerDb.secrets);
    defineTask('provision-roles', ['provision'], provisionDb.environment, provisionDb.secrets);
    const staffDb = db(PROCESS_LOGINS.staff);
    defineTask(
      'staff',
      ['staff'],
      { DONOR_STAFF_ORIGIN: config.staffOrigin, ...staffDb.environment },
      staffDb.secrets,
    );
    const rekeyDb = db(PROCESS_LOGINS.rekey);
    defineTask('rekey', ['rekey'], rekeyDb.environment, {
      ...rekeyDb.secrets,
      ...secretFields(appSecrets.encryption, [
        'DONOR_EMAIL_ENCRYPTION_KEY',
        'DONOR_CONTENT_ENCRYPTION_KEY',
      ]),
    });
    const monitorDb = db(PROCESS_LOGINS.monitor);
    defineTask('monitor', ['monitor'], monitorDb.environment, monitorDb.secrets);

    // Creates the `owner` role as the RDS master. The only task that can read the master
    // secret; run it with the data stack's BootstrapSecurityGroupId.
    this.taskDefinitions['bootstrap-owner'] = ownerBootstrapTaskDefinition(this, {
      size: config.taskSizes.worker,
      logGroup: log,
      databaseHost,
      databaseName: config.dbName,
      masterSecret,
      ownerSecret: loginSecrets[OWNER_LOGIN.login],
    });

    const reconcileDb = db(PROCESS_LOGINS.reconcile);
    const reconcileTask = defineTask(
      'reconcile',
      ['reconcile'],
      { DONOR_STRIPE_REQUESTS_PER_SECOND: '25', ...reconcileDb.environment },
      { ...reconcileDb.secrets, ...secretFields(appSecrets.stripe, ['STRIPE_SECRET_KEY']) },
    );

    const schedulerRole = new iam.Role(this, 'ReconcileSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: {
          'aws:SourceArn': this.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: 'default/*' }),
        },
      }),
    });
    reconcileTask.grantRun(schedulerRole);
    // The schedule targets the task-definition FAMILY (an ARN with no revision), which
    // ECS resolves to the latest ACTIVE revision when it runs the task. DAD-Main's
    // pipeline registers a new revision pinned to each release's image tag, so a fixed
    // revision here would keep running the CDK-created one with the placeholder image.
    // `grantRun` above covers only that fixed revision, so also allow every revision of
    // this family on this cluster.
    const reconcileFamilyArn = cdk.Stack.of(this).formatArn({
      service: 'ecs',
      resource: 'task-definition',
      resourceName: reconcileTask.family,
    });
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunLatestReconcileRevision',
        actions: ['ecs:RunTask'],
        resources: [`${reconcileFamilyArn}:*`],
        conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
      }),
    );

    const subnets = vpc.selectSubnets(computeSubnets);

    const scheduleDlq = new sqs.Queue(this, 'ReconcileScheduleDlq', {
      queueName: `dad-${config.env}-reconcile-schedule-dlq`,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    scheduleDlq.grantSendMessages(schedulerRole);

    this.reconcileSchedule = new scheduler.CfnSchedule(
      this,
      'ReconcileSchedule',
      {
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: 'cron(30 0 * * ? *)',
        scheduleExpressionTimezone: 'America/New_York',
        description:
          'DAD reconcile: daily Stripe↔DB reconciliation (non-zero exit on discrepancy).',
        target: {
          arn: cluster.clusterArn,
          roleArn: schedulerRole.roleArn,
          retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
          deadLetterConfig: { arn: scheduleDlq.queueArn },
          ecsParameters: {
            taskDefinitionArn: reconcileFamilyArn,
            launchType: 'FARGATE',
            taskCount: 1,
            networkConfiguration: {
              awsvpcConfiguration: {
                assignPublicIp: 'DISABLED',
                subnets: subnets.subnetIds,
                securityGroups: [workersSecurityGroup.securityGroupId],
              },
            },
          },
        },
      },
    );

    // Matches only what the reconcile job logs; a task that never starts logs nothing, so
    // reconcileFailedToRunRule below covers that case.
    const exitMetricFilter = log.addMetricFilter('ReconcileNonZeroExit', {
      filterName: `dad-${config.env}-reconcile-nonzero-exit`,
      metricNamespace: `DAD/${config.env}/Reconcile`,
      metricName: 'NonZeroExit',
      filterPattern: logs.FilterPattern.anyTerm(
        'reconcile discrepancy',
        'exit status 1',
        'FATAL',
      ),
      metricValue: '1',
      defaultValue: 0,
    });

    this.reconcileExitAlarm = new cloudwatch.Alarm(this, 'ReconcileExitAlarm', {
      alarmName: `dad-${config.env}-reconcile-nonzero-exit`,
      alarmDescription:
        'Reconcile task reported a discrepancy (non-zero exit). Investigate Stripe↔DB drift.',
      metric: exitMetricFilter.metric({
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.reconcileExitAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    this.reconcileFailedToRunRule = new events.Rule(this, 'ReconcileTaskFailedRule', {
      description: 'Reconcile task stopped with a non-zero exit or never started.',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [cluster.clusterArn],
          lastStatus: ['STOPPED'],
          taskDefinitionArn: [{ prefix: `${reconcileFamilyArn}:` }],
          $or: [
            { containers: { exitCode: [{ 'anything-but': 0 }] } },
            { stopCode: ['TaskFailedToStart'] },
          ],
        },
      },
      targets: [new targets.SnsTopic(alarmTopic)],
    });
  }
}
