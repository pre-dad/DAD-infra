/**
 * Shared DAD account/region configuration: the account ids, region and `-c env`
 * resolution that both CDK apps import and extend with their own fields.
 */

/** The two supported deployment environments. */
export type EnvName = 'staging' | 'production';

/** Resolved, fully-typed shared configuration for a single environment. */
export interface EnvConfig {
  /** Environment name. */
  readonly env: EnvName;
  /** 12-digit AWS account id this environment deploys into. */
  readonly account: string;
  /** AWS region the environment's stacks deploy into. */
  readonly region: string;
}

/** Primary region for all stacks; the production DR backup vault is the only us-west-2 resource. */
export const REGION = 'us-east-2';

/** sandbox account — the `staging` deploy target. */
export const STAGING_ACCOUNT = '853377042897';

/** production account — the `production` deploy target. */
export const PRODUCTION_ACCOUNT = '216833405626';

const STAGING: EnvConfig = Object.freeze({
  env: 'staging',
  account: STAGING_ACCOUNT,
  region: REGION,
});

const PRODUCTION: EnvConfig = Object.freeze({
  env: 'production',
  account: PRODUCTION_ACCOUNT,
  region: REGION,
});

const CONFIGS: Record<EnvName, EnvConfig> = {
  staging: STAGING,
  production: PRODUCTION,
};

/**
 * Resolve the shared config for an environment name.
 *
 * @param env environment selector; defaults to `staging` when undefined/empty.
 * @throws if `env` is a non-empty value that is not `staging` or `production`.
 */
export function getConfig(env?: string): EnvConfig {
  const name = (env ?? '').trim().toLowerCase();
  if (name === '' || name === 'staging') {
    return CONFIGS.staging;
  }
  if (name === 'production') {
    return CONFIGS.production;
  }
  throw new Error(
    `Unknown env '${env}'. Expected 'staging' or 'production' (default 'staging').`,
  );
}
