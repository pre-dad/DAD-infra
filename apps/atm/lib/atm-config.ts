/**
 * atm-specific environment configuration.
 *
 * Imports the shared DAD account/region core from `@dad-infra/config` and
 * extends it with the fields the ATM-on-AWS stacks need (see docs/design/aws-infra-design.md).
 *
 * GitHub read for the CodeBuild clone is an optional GITHUB_APP_TOKEN supplied by
 * whoever calls StartBuild, NOT a stored CodeBuild GitHub connection. A caller must
 * override it with type SECRETS_MANAGER or PARAMETER_STORE: StartBuild overrides default to
 * PLAINTEXT, which would expose the value in the build record. Scheduled runs supply none
 * and clone anonymously, which works only while DAD-Main is public.
 */
import {
  type EnvConfig as SharedEnvConfig,
  type EnvName,
  getConfig as getSharedConfig,
} from '@dad-infra/config';
import { Duration, aws_codebuild as codebuild } from 'aws-cdk-lib';

export type { EnvName };

/** The DAD-Main GitHub repo slug the runner clones. */
export const DAD_MAIN_REPO = 'pre-dad/DAD-Main';

/** Resource-name prefix for every atm resource. */
export const RESOURCE_PREFIX = 'atm';

/** Fully-resolved atm configuration for a single environment. */
export interface AtmEnvConfig extends SharedEnvConfig {
  readonly prefix: string;
  /** S3 evidence object-expiry window, in days. */
  readonly evidenceRetentionDays: number;
  /** CloudWatch log retention for the runner, in days. */
  readonly logRetentionDays: number;
  /** CodeBuild compute size for the runner. */
  readonly computeType: codebuild.ComputeType;
  readonly buildTimeout: Duration;
  /** Whether stateful resources carry deletion protection. */
  readonly deletionProtection: boolean;
  readonly githubRepo: string;
}

interface AtmOverrides {
  readonly evidenceRetentionDays: number;
  readonly logRetentionDays: number;
  readonly computeType: codebuild.ComputeType;
  readonly buildTimeout: Duration;
  readonly deletionProtection: boolean;
}

const OVERRIDES: Record<EnvName, AtmOverrides> = {
  staging: {
    evidenceRetentionDays: 90,
    logRetentionDays: 30,
    computeType: codebuild.ComputeType.MEDIUM,
    buildTimeout: Duration.hours(1),
    deletionProtection: false,
  },
  production: {
    evidenceRetentionDays: 365,
    logRetentionDays: 365,
    computeType: codebuild.ComputeType.LARGE,
    buildTimeout: Duration.hours(2),
    deletionProtection: true,
  },
};

/**
 * Resolve the atm config for an environment name. Delegates env validation and
 * the account/region map to the shared `@dad-infra/config`, then layers on the
 * atm-specific fields.
 */
export function getAtmConfig(env?: string): AtmEnvConfig {
  const shared = getSharedConfig(env);
  const overrides = OVERRIDES[shared.env];
  return {
    ...shared,
    prefix: RESOURCE_PREFIX,
    evidenceRetentionDays: overrides.evidenceRetentionDays,
    logRetentionDays: overrides.logRetentionDays,
    computeType: overrides.computeType,
    buildTimeout: overrides.buildTimeout,
    deletionProtection: overrides.deletionProtection,
    githubRepo: DAD_MAIN_REPO,
  };
}
