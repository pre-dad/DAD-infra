import * as cdk from 'aws-cdk-lib';
import { getConfig, EnvConfig, EnvName } from '../lib/config';
import { buildDadApp } from '../lib/dad-app';

const ENV = { account: '111111111111', region: 'us-east-2' };

/** Build the full stack graph for an env, returning each stack for assertions. */
export function buildGraph(
  name: EnvName = 'staging',
  overrides: Partial<EnvConfig> = {},
  context: Record<string, string> = {},
) {
  const app = new cdk.App({ context });
  const config: EnvConfig = { ...getConfig(name), ...overrides };

  const stacks = buildDadApp(app, config, ENV);
  return { app, config, ...stacks };
}
