import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { TaskSize } from './config';
import { buildPasswordlessDatabaseUrl, passwordVariable, ProcessLogin } from './db-url';

/** The application and SMTP secrets the task definitions inject as env vars. */
export interface AppSecrets {
  /** dad/<env>/app/stripe: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. */
  readonly stripe: secretsmanager.ISecret;
  /** dad/<env>/app/encryption: DONOR_EMAIL_ENCRYPTION_KEY, DONOR_CONTENT_ENCRYPTION_KEY. */
  readonly encryption: secretsmanager.ISecret;
  /** dad/<env>/ingress/tls: INGRESS_TLS_FULLCHAIN, INGRESS_TLS_PRIVKEY. */
  readonly tls: secretsmanager.ISecret;
  /** dad/<env>/app/sign-in: optional live SMS and OIDC API settings. */
  readonly signIn: secretsmanager.ISecret;
  /** dad/<env>/app/web-oauth: browser OAuth exchange credentials, web only. */
  readonly webOAuth: secretsmanager.ISecret;
  /** dad/<env>/ses/smtp: DONOR_SMTP_HOST/PORT/USERNAME/PASSWORD, DONOR_EMAIL_FROM. */
  readonly smtp: secretsmanager.ISecret;
}

/** ECS secrets for the named JSON fields of one Secrets Manager secret. */
export function secretFields(
  secret: secretsmanager.ISecret,
  fields: readonly string[],
): Record<string, ecs.Secret> {
  return Object.fromEntries(
    fields.map((f) => [f, ecs.Secret.fromSecretsManager(secret, f)]),
  );
}

/** Where one task reads its database connection from. */
export interface DatabaseConnection {
  /** Plain environment: the password-less URL under the login's URL variable. */
  readonly environment: Record<string, string>;
  /** ECS secret: the login secret's `password` key under `<PREFIX>_PASSWORD`. */
  readonly secrets: Record<string, ecs.Secret>;
}

/**
 * A task's database connection: a password-less URL in `environment` and the password as
 * an ECS secret, so no task-definition value holds it. The execution role is granted read
 * on exactly this login's secret by the `ecs.Secret` reference.
 */
export function databaseConnection(
  login: ProcessLogin,
  loginSecret: secretsmanager.ISecret,
  proxyEndpoint: string,
  db: string,
): DatabaseConnection {
  return {
    environment: {
      [login.envVar]: buildPasswordlessDatabaseUrl({
        login: login.login,
        proxyEndpoint,
        db,
      }),
    },
    secrets: {
      [passwordVariable(login.envVar)]: ecs.Secret.fromSecretsManager(loginSecret, 'password'),
    },
  };
}

/** Which built image a task runs. */
export type ImageName = 'api' | 'web' | 'nginx';

/** Inputs for building one Fargate task definition + its container. */
export interface TaskDefinitionSpec {
  /** Logical id for the task definition construct. */
  readonly id: string;
  /** The image repository to pull from (dad/api, dad/web, dad/nginx). */
  readonly image: ImageName;
  /** Optional image tag; defaults to the factory's default tag. */
  readonly imageTag?: string;
  /** Fargate CPU/memory sizing. */
  readonly size: TaskSize;
  /**
   * Container command override. Omit to use the image's default CMD
   * (api → `api`, web → `node server.js`, nginx → entrypoint).
   */
  readonly command?: string[];
  /** Plain (non-secret) environment variables. */
  readonly environment?: Record<string, string>;
  /** Secret environment variables (valueFrom Secrets Manager). */
  readonly secrets?: Record<string, ecs.Secret>;
  /** Container ports to expose (e.g. 8002 for api, 8080/8443 for nginx). */
  readonly portMappings?: ecs.PortMapping[];
  /**
   * Container health check. ECS ignores a Dockerfile HEALTHCHECK, so a service whose
   * rollout should be gated on health must declare it here. Omit for tasks with no
   * HTTP surface (the workers, one-off maintenance tasks).
   */
  readonly healthCheck?: ecs.HealthCheck;
  /** The log group this task writes to. */
  readonly logGroup: logs.ILogGroup;
  /** Log stream prefix (defaults to the task id). */
  readonly logStreamPrefix?: string;
}

/**
 * A reusable Fargate task-definition factory.
 *
 * Centralizes the repeated wiring every DAD task needs: Fargate CPU/memory,
 * a single container from one of the three ECR repos running as the Dockerfile
 * uid, awslogs to the per-service log group, env + task secrets, and port
 * mappings. Both the services stack and the maintenance stack build their task
 * definitions through this so the shape stays identical.
 */
export class TaskFactory {
  constructor(
    private readonly scope: Construct,
    private readonly repositories: Record<ImageName, ecr.IRepository>,
    /**
     * Tag used for every image that does not set its own. The stacks pass the
     * SSM-backed last-deployed tag (see image-tag.ts); `latest` is only a fallback
     * for callers that do not care.
     */
    private readonly defaultImageTag: string = 'latest',
  ) {}

  /** Build a Fargate task definition with a single primary container. */
  public build(spec: TaskDefinitionSpec): {
    taskDefinition: ecs.FargateTaskDefinition;
    container: ecs.ContainerDefinition;
  } {
    const taskDefinition = new ecs.FargateTaskDefinition(
      this.scope,
      `${spec.id}-TaskDef`,
      {
        cpu: spec.size.cpu,
        memoryLimitMiB: spec.size.memoryMiB,
        family: `dad-${spec.id}`,
      },
    );

    const container = taskDefinition.addContainer(`${spec.id}-Container`, {
      image: ecs.ContainerImage.fromEcrRepository(
        this.repositories[spec.image],
        spec.imageTag ?? this.defaultImageTag,
      ),
      command: spec.command,
      environment: spec.environment,
      secrets: spec.secrets,
      healthCheck: spec.healthCheck,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: spec.logGroup,
        streamPrefix: spec.logStreamPrefix ?? spec.id,
      }),
    });

    for (const pm of spec.portMappings ?? []) {
      container.addPortMappings(pm);
    }

    // ECR pull is granted to the EXECUTION role automatically by
    // `ContainerImage.fromEcrRepository` above (ECS pulls the image as the execution
    // role). The task role is the identity the running container assumes and never pulls
    // an image, so it is deliberately not granted ECR access.

    return { taskDefinition, container };
  }
}
