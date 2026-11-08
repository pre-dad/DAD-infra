import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { EnvConfig } from './config';
import { PROCESS_LOGINS } from './db-url';
import { ServiceName } from './ecs-cluster-stack';
import { imageTagFor } from './image-tag';
import { AppSecrets, databaseConnection, secretFields, TaskFactory } from './task-factory';
import { ServiceScaling } from './config';

/** Props for {@link ServicesStack}. */
export interface ServicesStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  readonly computeSubnets: ec2.SubnetSelection;
  readonly cluster: ecs.ICluster;
  readonly namespaceName: string;
  readonly repositories: Record<'api' | 'web' | 'nginx', ecr.IRepository>;
  readonly logGroups: Record<ServiceName, logs.ILogGroup>;
  /** RDS Proxy endpoint host used to build per-process DB URLs. */
  readonly proxyEndpoint: string;
  /** DB login secrets keyed by login name (from the data stack). */
  readonly loginSecrets: Record<string, secretsmanager.ISecret>;
  /** CIDRs of the web/compute tier for DONOR_TRUSTED_PROXY_CIDRS. */
  readonly computeSubnetCidrs: string[];
  /** SGs from the network stack. */
  readonly nginxSecurityGroup: ec2.ISecurityGroup;
  readonly webSecurityGroup: ec2.ISecurityGroup;
  readonly apiSecurityGroup: ec2.ISecurityGroup;
  readonly workersSecurityGroup: ec2.ISecurityGroup;
  /** Application and SMTP secrets (see {@link AppSecrets}). */
  readonly appSecrets: AppSecrets;
}

/** Internal description of one worker service. */
interface WorkerSpec {
  readonly service: ServiceName;
  readonly kind: string;
  readonly processId: keyof typeof PROCESS_LOGINS & string;
  /** Whether this worker needs the mail-transport env (SMTP + public origin). */
  readonly mail: boolean;
}

/**
 * ServicesStack.
 *
 * Exactly nine long-running Fargate services matching docker-compose.prod.yml:
 * api, web, nginx, and the six workers. Each is built through the shared
 * {@link TaskFactory}. The api is registered in Service Connect as `api` so web
 * resolves `http://api:8002`, and web as `web` so nginx resolves its `web:3000`
 * upstream; the SG chain (from the network stack) restricts api:8002 to the web
 * tier and web:3000 to nginx.
 */
export class ServicesStack extends cdk.Stack {
  public readonly services: Record<ServiceName, ecs.FargateService>;

  private config!: ServicesStackProps['config'];

  private get azRebalancing(): ecs.AvailabilityZoneRebalancing | undefined {
    return this.config.availabilityZoneRebalancing
      ? ecs.AvailabilityZoneRebalancing.ENABLED
      : undefined;
  }

  /**
   * The desired count to put in the template. Omitted for an autoscaled service: with
   * a count in the template every `cdk deploy` would reset a scaled-out service back
   * to it. The scaling floor (the configured count) is then the effective minimum.
   */
  private initialCount(name: 'api' | 'web' | 'nginx'): number | undefined {
    return this.config.autoscaling.enabled ? undefined : this.config.desiredCounts[name];
  }

  /** Target-tracking scaling on CPU, and memory when the service configures it. */
  private autoscale(
    name: 'api' | 'web' | 'nginx',
    service: ecs.FargateService,
    scaling: ServiceScaling,
  ): void {
    const min = this.config.desiredCounts[name];
    if (scaling.maxCount < min) {
      throw new Error(
        `autoscaling.${name}.maxCount (${scaling.maxCount}) is below the desired count (${min})`,
      );
    }
    const target = service.autoScaleTaskCount({
      minCapacity: min,
      maxCapacity: scaling.maxCount,
    });
    target.scaleOnCpuUtilization(`${name}-Cpu`, {
      targetUtilizationPercent: scaling.cpuTargetPercent,
      scaleOutCooldown: cdk.Duration.minutes(1),
      scaleInCooldown: cdk.Duration.minutes(5),
    });
    if (scaling.memoryTargetPercent !== undefined) {
      target.scaleOnMemoryUtilization(`${name}-Memory`, {
        targetUtilizationPercent: scaling.memoryTargetPercent,
        scaleOutCooldown: cdk.Duration.minutes(1),
        scaleInCooldown: cdk.Duration.minutes(5),
      });
    }
  }

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);
    this.config = props.config;

    const {
      config,
      computeSubnets,
      cluster,
      namespaceName,
      repositories,
      logGroups,
      proxyEndpoint,
      loginSecrets,
      computeSubnetCidrs,
      nginxSecurityGroup,
      webSecurityGroup,
      apiSecurityGroup,
      workersSecurityGroup,
      appSecrets,
    } = props;

    // Which secret fields each process reads, mirroring docker-compose.prod.yml.
    const stripeKey = secretFields(appSecrets.stripe, ['STRIPE_SECRET_KEY']);
    const emailKey = secretFields(appSecrets.encryption, ['DONOR_EMAIL_ENCRYPTION_KEY']);
    // The API queues mail (host, port, sender) but never logs in to the relay.
    const mailQueue = secretFields(appSecrets.smtp, [
      'DONOR_SMTP_HOST',
      'DONOR_SMTP_PORT',
      'DONOR_EMAIL_FROM',
    ]);
    // The mail workers deliver it, so they also get the relay credentials.
    const mailTransport = {
      ...mailQueue,
      ...secretFields(appSecrets.smtp, ['DONOR_SMTP_USERNAME', 'DONOR_SMTP_PASSWORD']),
    };

    const factory = new TaskFactory(this, repositories, imageTagFor(this, config));
    this.services = {} as Record<ServiceName, ecs.FargateService>;

    // A rollout that cannot reach a steady state (tasks failing to start or failing
    // their health check) is stopped and rolled back to the last good task definition.
    // DAD-Main's deploy.yml then sees the new deployment end as FAILED rather than
    // COMPLETED, which is its deploy gate (no shell into running tasks needed).
    const rollout = { circuitBreaker: { rollback: true } };

    // Each process gets a password-less URL in its environment and the login secret's
    // password as an ECS secret (<PREFIX>_PASSWORD), which DAD-Main combines at start.
    const db = (processId: string) => {
      const login = PROCESS_LOGINS[processId];
      return databaseConnection(login, loginSecrets[login.login], proxyEndpoint, config.dbName);
    };

    const trustedProxyCidrs = computeSubnetCidrs.join(',');

    // --- api ------------------------------------------------------------
    const apiDb = db('api');
    const api = factory.build({
      id: 'api',
      image: 'api',
      size: config.taskSizes.api,
      // image default CMD is `api`.
      environment: {
        DONOR_GO_LISTEN: '0.0.0.0:8002',
        DONOR_PUBLIC_ORIGIN: config.publicOrigin,
        DONOR_STAFF_ORIGIN: config.staffOrigin,
        DONOR_TRUSTED_PROXY_CIDRS: trustedProxyCidrs,
        ...apiDb.environment,
      },
      secrets: {
        ...apiDb.secrets,
        ...secretFields(appSecrets.stripe, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']),
        ...secretFields(appSecrets.encryption, [
          'DONOR_EMAIL_ENCRYPTION_KEY',
          'DONOR_CONTENT_ENCRYPTION_KEY',
        ]),
        ...mailQueue,
      },
      portMappings: [{ containerPort: 8002, name: 'api' }],
      // Same probe as docker-compose.prod.yml. Liveness, not readiness: /health/ready
      // checks migration history through PostgreSQL, so a database outage would fail
      // every task's health check and ECS would replace them all in a loop. `migrate`
      // runs before the rollout and already proves database connectivity.
      healthCheck: {
        command: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8002/health/live'],
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        retries: 10,
        startPeriod: cdk.Duration.seconds(30),
      },
      logGroup: logGroups.api,
    });
    this.services.api = new ecs.FargateService(this, 'ApiService', {
      ...rollout,
      cluster,
      serviceName: 'api',
      taskDefinition: api.taskDefinition,
      desiredCount: this.initialCount('api'),
      availabilityZoneRebalancing: this.azRebalancing,
      vpcSubnets: computeSubnets,
      securityGroups: [apiSecurityGroup],
      // Register `api` in Service Connect so web resolves http://api:8002.
      serviceConnectConfiguration: {
        namespace: namespaceName,
        services: [
          {
            portMappingName: 'api',
            dnsName: 'api',
            port: 8002,
          },
        ],
      },
    });

    // --- web ------------------------------------------------------------
    const web = factory.build({
      id: 'web',
      image: 'web',
      size: config.taskSizes.web,
      // image default CMD is `node server.js`.
      environment: {
        DONOR_API_BASE_URL: 'http://api:8002',
        DONOR_CLIENT_IP_HEADER: 'X-Real-IP',
      },
      portMappings: [{ containerPort: 3000, name: 'web' }],
      // Same probe as the web Dockerfile HEALTHCHECK, which ECS ignores.
      healthCheck: {
        command: [
          'CMD',
          'node',
          '-e',
          "require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))",
        ],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(20),
      },
      logGroup: logGroups.web,
    });
    this.services.web = new ecs.FargateService(this, 'WebService', {
      ...rollout,
      cluster,
      serviceName: 'web',
      taskDefinition: web.taskDefinition,
      desiredCount: this.initialCount('web'),
      availabilityZoneRebalancing: this.azRebalancing,
      vpcSubnets: computeSubnets,
      securityGroups: [webSecurityGroup],
      // web resolves `api` as a client and publishes itself as `web:3000`, the upstream
      // name nginx resolves at start.
      serviceConnectConfiguration: {
        namespace: namespaceName,
        services: [
          {
            portMappingName: 'web',
            dnsName: 'web',
            port: 3000,
          },
        ],
      },
    });

    // --- nginx ----------------------------------------------------------
    const nginx = factory.build({
      id: 'nginx',
      image: 'nginx',
      size: config.taskSizes.nginx,
      environment: {
        INGRESS_MODE: 'cloudflare',
        DONOR_PUBLIC_ORIGIN: config.publicOrigin,
        DONOR_STAFF_ORIGIN: config.staffOrigin,
        NGINX_ENVSUBST_FILTER: '^INGRESS_',
        NGINX_ENTRYPOINT_QUIET_LOGS: '1',
      },
      // Written to /etc/nginx/tls by the image's 04-tls-from-env.sh (ECS cannot mount a
      // secret as a file).
      secrets: secretFields(appSecrets.tls, ['INGRESS_TLS_FULLCHAIN', 'INGRESS_TLS_PRIVKEY']),
      // 8081 is nginx's loopback-only /health listener: probed inside the task, never
      // exposed, so it has no port mapping.
      portMappings: [
        { containerPort: 8080, name: 'http' },
        { containerPort: 8443, name: 'https' },
      ],
      // Same probe as docker-compose.prod.yml.
      healthCheck: {
        command: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8081/health'],
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
        startPeriod: cdk.Duration.seconds(20),
      },
      logGroup: logGroups.nginx,
    });
    this.services.nginx = new ecs.FargateService(this, 'NginxService', {
      ...rollout,
      cluster,
      serviceName: 'nginx',
      taskDefinition: nginx.taskDefinition,
      desiredCount: this.initialCount('nginx'),
      availabilityZoneRebalancing: this.azRebalancing,
      vpcSubnets: computeSubnets,
      securityGroups: [nginxSecurityGroup],
      // nginx is a Service Connect client only: it resolves `web` once at start.
      serviceConnectConfiguration: { namespace: namespaceName },
    });
    // The `web` name must exist before nginx starts, or nginx exits on an unknown upstream.
    this.services.nginx.node.addDependency(this.services.web);

    if (config.autoscaling.enabled) {
      this.autoscale('api', this.services.api, config.autoscaling.api);
      this.autoscale('web', this.services.web, config.autoscaling.web);
      this.autoscale('nginx', this.services.nginx, config.autoscaling.nginx);
    }

    // --- the six workers ------------------------------------------------
    const workers: WorkerSpec[] = [
      {
        service: 'stripe-worker',
        kind: 'stripe',
        processId: 'worker-stripe',
        mail: false,
      },
      {
        service: 'projection-worker',
        kind: 'projections',
        processId: 'worker-projections',
        mail: false,
      },
      {
        service: 'login-email-worker',
        kind: 'login-email',
        processId: 'worker-login-email',
        mail: true,
      },
      {
        service: 'email-change-worker',
        kind: 'email-changes',
        processId: 'worker-email-changes',
        mail: true,
      },
      {
        service: 'message-worker',
        kind: 'messages',
        processId: 'worker-messages',
        mail: true,
      },
      {
        service: 'push-worker',
        kind: 'push',
        processId: 'worker-push',
        mail: false,
      },
    ];

    for (const w of workers) {
      const workerDb = db(w.processId);
      const environment: Record<string, string> = {
        // The worker binary refuses to start without this; whether workers run at all
        // is config.workersEnabled (their desired count).
        DONOR_GO_WORKERS_ENABLED: 'true',
        ...workerDb.environment,
      };
      if (w.service === 'stripe-worker') {
        environment.DONOR_STRIPE_REQUESTS_PER_SECOND = '25';
      }
      if (w.mail) {
        environment.DONOR_PUBLIC_ORIGIN = config.publicOrigin;
      }

      const built = factory.build({
        id: w.service,
        image: 'api',
        size: config.taskSizes.worker,
        command: ['worker', '--kind', w.kind],
        environment,
        secrets: {
          ...workerDb.secrets,
          ...(w.service === 'stripe-worker' ? stripeKey : {}),
          ...(w.mail ? { ...emailKey, ...mailTransport } : {}),
        },
        logGroup: logGroups[w.service],
      });

      this.services[w.service] = new ecs.FargateService(
        this,
        `${w.service}-Service`,
        {
          ...rollout,
          cluster,
          serviceName: w.service,
          taskDefinition: built.taskDefinition,
          // The single worker switch (config.workersEnabled); see EnvConfig.
          desiredCount: config.workersEnabled ? config.desiredCounts.workers : 0,
          vpcSubnets: computeSubnets,
          securityGroups: [workersSecurityGroup],
        },
      );
    }
  }
}
