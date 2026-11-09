import * as cdk from 'aws-cdk-lib';
import { EnvConfig } from './config';

/**
 * Dummy account ids used for offline synth: CI and AGENTS.md use 000000000000, the
 * README uses 111111111111, and the test helpers use 111111111111. They are not real
 * accounts, so they can never point a deploy at the wrong place.
 */
const OFFLINE_PLACEHOLDER_ACCOUNTS: readonly string[] = ['000000000000', '111111111111'];

/**
 * Resolve the CDK target and refuse one that does not match the selected env.
 *
 * The `cdk` CLI overwrites CDK_DEFAULT_ACCOUNT/REGION from the active AWS profile, and
 * those win over the config, so a laptop deploy under the wrong SSO profile would
 * otherwise target the wrong account or region (the stacks hardcode us-east-2 zones).
 * A real account must equal the configured one, and the region must equal the configured
 * one. An offline placeholder account is exempt from both checks: it has no credentials,
 * so it cannot deploy anywhere, and the CLI replaces the dummy region with the profile
 * default (us-east-1 when AWS_REGION is unset), which would otherwise break the
 * documented dummy-credential synth gate on a laptop. Unset variables fall back to config.
 *
 * @throws if a non-placeholder account differs from config, or its region differs.
 */
export function resolveTarget(
  config: Pick<EnvConfig, 'env' | 'account' | 'region'>,
  defaultAccount: string | undefined = process.env.CDK_DEFAULT_ACCOUNT,
  defaultRegion: string | undefined = process.env.CDK_DEFAULT_REGION,
): cdk.Environment {
  const account = defaultAccount ?? config.account;
  const region = defaultRegion ?? config.region;

  if (OFFLINE_PLACEHOLDER_ACCOUNTS.includes(account)) {
    return { account, region };
  }
  if (region !== config.region) {
    throw new Error(
      `Wrong region for env=${config.env}: expected ${config.region} but the CDK target is ` +
        `${region}. Set AWS_REGION=${config.region} AWS_DEFAULT_REGION=${config.region} ` +
        `(or fix the profile region) and retry.`,
    );
  }
  if (account !== config.account) {
    throw new Error(
      `Wrong account for env=${config.env}: expected ${config.account} but the CDK target is ` +
        `${account}. Check AWS_PROFILE (aws sts get-caller-identity) matches the ` +
        `${config.env} account, or select the other env with -c env=.`,
    );
  }
  return { account, region };
}
