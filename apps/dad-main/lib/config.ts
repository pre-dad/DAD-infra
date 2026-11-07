/**
 * Typed per-environment configuration for the DAD-Main AWS deployment.
 *
 * The account/region/env-selection CORE is single-sourced from the shared
 * `@dad-infra/config` package (one place for the DAD account ids, region, and
 * `-c env` resolution). This module layers the DAD-Main-specific fields
 * (hostnames, sizing, feature toggles, db name) on top, so it stays the single
 * module every stack, bin, and test imports from `./config`.
 *
 * Confirmed facts (from DAD-Main docs/aws-deployment.md):
 *   - region is always us-east-2 (Ohio)
 *   - staging account 853377042897, production account 216833405626
 *   - hosts live under dynamicaid.org; sending subdomain is a dedicated mail.* host
 *   - db name defaults to `dad`
 */
import {
  EnvName,
  EnvConfig as SharedEnvConfig,
  getConfig as getSharedConfig,
} from '@dad-infra/config';

/** Re-export the env name type so dependents keep importing it from `./config`. */
export { EnvName };

/** Fargate task sizing (CPU units / memory MiB) for one service tier. */
export interface TaskSize {
  /** Fargate CPU units (e.g. 256 = 0.25 vCPU, 512 = 0.5 vCPU, 1024 = 1 vCPU). */
  readonly cpu: number;
  /** Fargate memory in MiB (must be a valid pairing with `cpu`). */
  readonly memoryMiB: number;
}

/** RDS instance sizing. */
export interface DatabaseSizing {
  /** EC2-style instance type without the `db.` prefix (e.g. `t3.large`, `t4g.small`). */
  readonly instanceType: string;
  /** Initial storage in GiB. */
  readonly allocatedStorageGiB: number;
  /** Storage autoscaling ceiling in GiB. */
  readonly maxAllocatedStorageGiB: number;
}

/** Desired running task counts for the long-running services. */
export interface DesiredCounts {
  readonly api: number;
  readonly web: number;
  readonly nginx: number;
  /** Applied to each of the six worker services. */
  readonly workers: number;
}

/** Per-tier Fargate task sizes. Workers share one tier. */
export interface TaskSizes {
  readonly api: TaskSize;
  readonly web: TaskSize;
  readonly nginx: TaskSize;
  readonly worker: TaskSize;
}

/**
 * Target-tracking autoscaling for one service. The floor is the service's desired count
 * (`desiredCounts`), so scaling can only add capacity above what the environment is
 * sized for.
 */
export interface ServiceScaling {
  /** Most tasks the service may scale out to. Must be at least its desired count. */
  readonly maxCount: number;
  /** Average CPU utilisation (percent) the service is scaled to hold. */
  readonly cpuTargetPercent: number;
  /** Average memory utilisation (percent) to hold; omit to scale on CPU alone. */
  readonly memoryTargetPercent?: number;
}

/**
 * Autoscaling for the three request-serving services. There is no ALB request-count
 * signal: traffic enters through a Network Load Balancer, which has no per-target
 * request metric, so scaling follows CPU (and memory where it tracks load). The workers
 * are fixed at `desiredCounts.workers`.
 */
export interface AutoscalingConfig {
  readonly enabled: boolean;
  readonly api: ServiceScaling;
  readonly web: ServiceScaling;
  readonly nginx: ServiceScaling;
}

/**
 * Resolved, fully-typed configuration for a single environment.
 *
 * Extends the shared core (`env`, `account`, `region`) with the DAD-Main
 * application fields.
 */
export interface EnvConfig extends SharedEnvConfig {
  /** Public donor site hostname (e.g. app.staging.dynamicaid.org). */
  readonly publicHost: string;
  /** Staff site hostname (e.g. staff.staging.dynamicaid.org). */
  readonly staffHost: string;
  /** Public origin: https:// + publicHost, lowercase, no trailing slash. */
  readonly publicOrigin: string;
  /** Staff origin: https:// + staffHost, lowercase, no trailing slash. */
  readonly staffOrigin: string;
  /** PostgreSQL database name. Defaults to `dad`. */
  readonly dbName: string;
  /** Whether RDS runs Multi-AZ. */
  readonly multiAz: boolean;
  /** Whether RDS and other stateful resources have deletion protection. */
  readonly deletionProtection: boolean;
  /** CloudWatch log retention in days. */
  readonly logRetentionDays: number;
  /** Desired running counts for the long-running services. */
  readonly desiredCounts: DesiredCounts;
  /** Fargate task sizes per service tier. */
  readonly taskSizes: TaskSizes;
  /** RDS instance class and storage. */
  readonly database: DatabaseSizing;
  /**
   * Whether ECS Container Insights is on. The service-health alarms read the
   * `ECS/ContainerInsights` namespace, so they exist only while this is true.
   */
  readonly containerInsights: boolean;
  /** Which VPC traffic the flow logs record. */
  readonly flowLogTrafficType: 'ALL' | 'REJECT';
  /** Target-tracking autoscaling for api, web and nginx. */
  readonly autoscaling: AutoscalingConfig;
  /**
   * Whether the interface VPC endpoints (ECR api and dkr, Secrets Manager, CloudWatch
   * Logs) are created. Each costs per AZ-hour plus data, so staging leaves them off
   * and pulls/logs/secrets go through the NAT gateway. The S3 gateway endpoint is free
   * and always created.
   */
  readonly interfaceEndpointsEnabled: boolean;
  /** CloudWatch retention in days for the VPC flow logs. */
  readonly flowLogRetentionDays: number;
  /** Dedicated SES sending subdomain (e.g. mail.staging.dynamicaid.org). */
  readonly sendingSubdomain: string;
  /** Whether the nginx ingress SG is restricted to Cloudflare ranges. */
  readonly cloudflareIngressEnabled: boolean;
  /**
   * Whether the six worker services run. The ONE switch for workers: when false their
   * desired count is 0, and DAD-Main's deploy.yml skips rolling services ECS reports at a
   * desired count of 0 instead of keeping its own flag. (The worker binary also requires
   * DONOR_GO_WORKERS_ENABLED=true; the task definitions always set it, so this switch is
   * the desired count, not that variable.)
   */
  readonly workersEnabled: boolean;
}

/** The DAD-Main-specific fields layered on top of the shared core, per env. */
type AppFields = Omit<EnvConfig, keyof SharedEnvConfig>;

/** Default PostgreSQL database name (confirmed from operations docs). */
const DEFAULT_DB_NAME = 'dad';

/**
 * Normalize a hostname into an https origin: lowercase, no trailing slash.
 */
function toOrigin(host: string): string {
  const h = host.trim().toLowerCase().replace(/\/+$/, '');
  return `https://${h}`;
}

/**
 * Production-typical task sizes. Staging runs the smaller tier to keep test
 * costs down; production bumps api/web/worker memory and CPU for headroom.
 *
 * These are sensible defaults chosen for the foundation and can be tuned per
 * service later without changing the shape of the config.
 */
const STAGING_TASK_SIZES: TaskSizes = {
  api: { cpu: 256, memoryMiB: 512 },
  web: { cpu: 512, memoryMiB: 1024 },
  nginx: { cpu: 256, memoryMiB: 512 },
  worker: { cpu: 256, memoryMiB: 512 },
};

const PRODUCTION_TASK_SIZES: TaskSizes = {
  api: { cpu: 1024, memoryMiB: 2048 },
  web: { cpu: 1024, memoryMiB: 2048 },
  nginx: { cpu: 512, memoryMiB: 1024 },
  worker: { cpu: 512, memoryMiB: 1024 },
};

/** Sized for a handful of testers on a single AZ. */
const STAGING_DATABASE: DatabaseSizing = {
  instanceType: 't4g.small',
  allocatedStorageGiB: 20,
  maxAllocatedStorageGiB: 200,
};

const PRODUCTION_DATABASE: DatabaseSizing = {
  instanceType: 't3.large',
  allocatedStorageGiB: 50,
  maxAllocatedStorageGiB: 200,
};

const STAGING_AUTOSCALING: AutoscalingConfig = {
  enabled: true,
  api: { maxCount: 3, cpuTargetPercent: 60, memoryTargetPercent: 75 },
  web: { maxCount: 3, cpuTargetPercent: 60, memoryTargetPercent: 75 },
  nginx: { maxCount: 2, cpuTargetPercent: 60 },
};

const PRODUCTION_AUTOSCALING: AutoscalingConfig = {
  enabled: true,
  api: { maxCount: 12, cpuTargetPercent: 60, memoryTargetPercent: 75 },
  web: { maxCount: 12, cpuTargetPercent: 60, memoryTargetPercent: 75 },
  nginx: { maxCount: 6, cpuTargetPercent: 60 },
};

const STAGING: AppFields = {
  publicHost: 'app.staging.dynamicaid.org',
  staffHost: 'staff.staging.dynamicaid.org',
  publicOrigin: toOrigin('app.staging.dynamicaid.org'),
  staffOrigin: toOrigin('staff.staging.dynamicaid.org'),
  dbName: DEFAULT_DB_NAME,
  multiAz: false,
  deletionProtection: false,
  logRetentionDays: 30,
  desiredCounts: { api: 1, web: 1, nginx: 1, workers: 1 },
  taskSizes: STAGING_TASK_SIZES,
  database: STAGING_DATABASE,
  containerInsights: false,
  flowLogTrafficType: 'REJECT',
  autoscaling: STAGING_AUTOSCALING,
  interfaceEndpointsEnabled: false,
  flowLogRetentionDays: 30,
  sendingSubdomain: 'mail.staging.dynamicaid.org',
  cloudflareIngressEnabled: true,
  // Off until the environment is ready to send mail and talk to Stripe (docs/bootstrap.md).
  workersEnabled: false,
};

const PRODUCTION: AppFields = {
  publicHost: 'app.dynamicaid.org',
  staffHost: 'staff.dynamicaid.org',
  publicOrigin: toOrigin('app.dynamicaid.org'),
  staffOrigin: toOrigin('staff.dynamicaid.org'),
  dbName: DEFAULT_DB_NAME,
  multiAz: true,
  deletionProtection: true,
  // Longer retention in production for audit/forensics.
  logRetentionDays: 365,
  desiredCounts: { api: 2, web: 2, nginx: 2, workers: 1 },
  taskSizes: PRODUCTION_TASK_SIZES,
  database: PRODUCTION_DATABASE,
  containerInsights: true,
  flowLogTrafficType: 'ALL',
  autoscaling: PRODUCTION_AUTOSCALING,
  interfaceEndpointsEnabled: true,
  flowLogRetentionDays: 365,
  sendingSubdomain: 'mail.dynamicaid.org',
  cloudflareIngressEnabled: true,
  workersEnabled: false,
};

const APP_FIELDS: Record<EnvName, AppFields> = {
  staging: STAGING,
  production: PRODUCTION,
};

/**
 * Resolve the config for an environment name.
 *
 * Account/region/env-validation come from the shared `@dad-infra/config`
 * `getConfig`; the DAD-Main app fields are merged on top. The resolved object
 * is field-for-field identical to the pre-extraction local config.
 *
 * @param env environment selector; defaults to `staging` when undefined/empty.
 * @throws if `env` is a non-empty value that is not `staging` or `production`.
 */
export function getConfig(env?: string): EnvConfig {
  const shared = getSharedConfig(env);
  return { ...shared, ...APP_FIELDS[shared.env] };
}
