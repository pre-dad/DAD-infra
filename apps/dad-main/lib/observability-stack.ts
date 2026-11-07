import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { EnvConfig } from './config';
import { ServiceName } from './ecs-cluster-stack';

/** Props for {@link ObservabilityStack}. */
export interface ObservabilityStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly clusterName: string;
  /** The nine long-running services keyed by service name. */
  readonly services: Record<ServiceName, ecs.FargateService>;
  /** The database instance, alarmed on CPU and free storage. */
  readonly database: rds.IDatabaseInstance;
  /**
   * Optional email address to subscribe to the SNS topic. Comes from CDK
   * context `alarmEmail` if not supplied; left unsubscribed when absent.
   */
  readonly alarmEmail?: string;
}

/**
 * ObservabilityStack.
 *
 * One SNS topic (optional email subscription), a per-service alarm for ECS
 * health (running task count below desired), and database CPU and storage alarms. All
 * alarms notify the SNS topic. The `monitor` task publishes no metric (it exits nonzero
 * when a queue is stale, and is scheduled and alerted on outside AWS), so there is
 * deliberately no queue-age alarm.
 */
export class ObservabilityStack extends cdk.Stack {
  public readonly topic: sns.Topic;
  public readonly serviceHealthAlarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { config, clusterName, services, database } = props;

    this.topic = new sns.Topic(this, 'Alarms', {
      topicName: `dad-${config.env}-alarms`,
      displayName: `DAD ${config.env} alarms`,
    });

    const email =
      props.alarmEmail ??
      (this.node.tryGetContext('alarmEmail') as string | undefined);
    if (email) {
      this.topic.addSubscription(new snsSubs.EmailSubscription(email));
    }

    const action = new cwActions.SnsAction(this.topic);

    // --- ECS service health: running < desired --------------------------
    // RunningTaskCount is a Container Insights metric: without it the alarms would sit
    // in ALARM on missing data, so they exist only while Container Insights is on.
    const monitoredServices = config.containerInsights
      ? (Object.entries(services) as Array<[ServiceName, ecs.FargateService]>)
      : [];
    for (const [name, service] of monitoredServices) {
      const running = new cloudwatch.Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'RunningTaskCount',
        dimensionsMap: {
          ClusterName: clusterName,
          ServiceName: service.serviceName,
        },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(1),
      });

      const isWorker = name !== 'api' && name !== 'web' && name !== 'nginx';
      // Workers are held at zero tasks while config.workersEnabled is off.
      if (isWorker && !config.workersEnabled) {
        continue;
      }
      const desired = isWorker ? config.desiredCounts.workers : config.desiredCounts[name];

      const alarm = new cloudwatch.Alarm(this, `Health-${name}`, {
        alarmName: `dad-${config.env}-${name}-unhealthy`,
        alarmDescription: `ECS service ${name} has fewer running tasks than desired (${desired}).`,
        metric: running,
        threshold: desired,
        evaluationPeriods: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      alarm.addAlarmAction(action);
      this.serviceHealthAlarms.push(alarm);
    }

    // --- database ---------------------------------------------------------
    const dbAlarms: Array<[string, cloudwatch.Metric, number, cloudwatch.ComparisonOperator, string]> = [
      [
        'DatabaseCpu',
        database.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
        80,
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        'Database CPU above 80% for 15 minutes.',
      ],
      [
        'DatabaseFreeStorage',
        database.metricFreeStorageSpace({ period: cdk.Duration.minutes(5) }),
        5 * 1024 ** 3,
        cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        'Database free storage below 5 GiB.',
      ],
    ];
    for (const [id, metric, threshold, comparisonOperator, description] of dbAlarms) {
      new cloudwatch.Alarm(this, id, {
        alarmName: `dad-${config.env}-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 3,
        comparisonOperator,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);
    }

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: this.topic.topicArn });
  }
}
