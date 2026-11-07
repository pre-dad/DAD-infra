import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import { EnvConfig } from './config';

/** Props for {@link EcsClusterStack}. */
export interface EcsClusterStackProps extends cdk.StackProps {
  /** Resolved per-environment configuration. */
  readonly config: EnvConfig;
  /** The dedicated VPC from the network stack. */
  readonly vpc: ec2.IVpc;
}

/** The ECS service names, mirroring docker-compose.prod.yml exactly. */
export const SERVICE_NAMES = [
  'api',
  'web',
  'nginx',
  'stripe-worker',
  'projection-worker',
  'login-email-worker',
  'email-change-worker',
  'message-worker',
  'push-worker',
] as const;

/** One of the nine long-running ECS service names. */
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** The ECS cluster name for an environment. One definition, used wherever it is needed. */
export function clusterNameFor(env: string): string {
  return `dad-${env}`;
}

/**
 * The worker services that send mail, and so read the SMTP relay credentials. The SMTP
 * rotation restarts exactly these after a rotation.
 */
export const MAIL_WORKER_SERVICES = [
  'login-email-worker',
  'email-change-worker',
  'message-worker',
] as const satisfies readonly ServiceName[];

/**
 * Map an env's logRetentionDays to the nearest supported CloudWatch
 * RetentionDays enum value. 30 → ONE_MONTH, 365 → ONE_YEAR.
 */
export function toRetentionDays(days: number): logs.RetentionDays {
  const supported: Array<[number, logs.RetentionDays]> = [
    [1, logs.RetentionDays.ONE_DAY],
    [3, logs.RetentionDays.THREE_DAYS],
    [5, logs.RetentionDays.FIVE_DAYS],
    [7, logs.RetentionDays.ONE_WEEK],
    [14, logs.RetentionDays.TWO_WEEKS],
    [30, logs.RetentionDays.ONE_MONTH],
    [60, logs.RetentionDays.TWO_MONTHS],
    [90, logs.RetentionDays.THREE_MONTHS],
    [120, logs.RetentionDays.FOUR_MONTHS],
    [150, logs.RetentionDays.FIVE_MONTHS],
    [180, logs.RetentionDays.SIX_MONTHS],
    [365, logs.RetentionDays.ONE_YEAR],
    [731, logs.RetentionDays.TWO_YEARS],
  ];
  let best = supported[0][1];
  for (const [n, enumValue] of supported) {
    if (n <= days) {
      best = enumValue;
    }
  }
  return best;
}

/**
 * EcsClusterStack.
 *
 * The Fargate cluster per environment with a Cloud Map / Service Connect
 * namespace, the three ECR repositories (dad/api, dad/web, dad/nginx) with
 * lifecycle policies to expire untagged and old images, and one CloudWatch log
 * group per service with retention taken from config.
 */
export class EcsClusterStack extends cdk.Stack {
  /** The Fargate cluster. */
  public readonly cluster: ecs.Cluster;
  /** The Service Connect / Cloud Map namespace name (e.g. dad.staging.local). */
  public readonly namespaceName: string;
  /** ECR repositories keyed by short image name (api, web, nginx). */
  public readonly repositories: Record<'api' | 'web' | 'nginx', ecr.Repository>;
  /** One log group per service, keyed by service name. */
  public readonly logGroups: Record<ServiceName, logs.LogGroup>;

  constructor(scope: Construct, id: string, props: EcsClusterStackProps) {
    super(scope, id, props);

    const { config, vpc } = props;

    this.namespaceName = `dad.${config.env}.local`;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: clusterNameFor(config.env),
      containerInsightsV2: config.containerInsights
        ? ecs.ContainerInsights.ENABLED
        : ecs.ContainerInsights.DISABLED,
      defaultCloudMapNamespace: {
        name: this.namespaceName,
        useForServiceConnect: true,
      },
    });

    // --- ECR repositories with lifecycle policies -----------------------
    const makeRepo = (shortName: 'api' | 'web' | 'nginx'): ecr.Repository =>
      new ecr.Repository(this, `Repo-${shortName}`, {
        repositoryName: `dad/${shortName}`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        lifecycleRules: [
          {
            description: 'Expire untagged images after 7 days.',
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: cdk.Duration.days(7),
          },
          {
            description: 'Keep only the most recent tagged images.',
            tagStatus: ecr.TagStatus.ANY,
            maxImageCount: config.env === 'production' ? 30 : 15,
          },
        ],
        removalPolicy: config.deletionProtection
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      });

    this.repositories = {
      api: makeRepo('api'),
      web: makeRepo('web'),
      nginx: makeRepo('nginx'),
    };

    // --- One log group per service --------------------------------------
    const retention = toRetentionDays(config.logRetentionDays);
    this.logGroups = {} as Record<ServiceName, logs.LogGroup>;
    for (const name of SERVICE_NAMES) {
      this.logGroups[name] = new logs.LogGroup(this, `Logs-${name}`, {
        logGroupName: `/dad/${config.env}/${name}`,
        retention,
        removalPolicy: config.deletionProtection
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      });
    }

    // --- Outputs ---------------------------------------------------------
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'NamespaceName', { value: this.namespaceName });
  }
}
