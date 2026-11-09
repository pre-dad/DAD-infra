#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { getConfig } from '../lib/config';
import { buildDadApp } from '../lib/dad-app';
import { resolveTarget } from '../lib/target-env';

/**
 * DAD infrastructure CDK app entrypoint.
 *
 * Environment is selected with `-c env=staging|production` (default staging).
 * Account/region come from the resolved EnvConfig, with CDK_DEFAULT_ACCOUNT /
 * CDK_DEFAULT_REGION as the offline-synth fallback so `cdk synth` works with
 * dummy credentials.
 *
 * The stack graph lives in lib/dad-app.ts.
 */
const app = new cdk.App();

const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'staging';
const config = getConfig(envName);

// Resolve the deployment target.
//
// For a real deploy, the account/region come from the resolved EnvConfig. For
// offline synth there are no credentials for the real account, and several
// constructs (VPC AZ selection, NLB) would otherwise trigger context lookups
// that require AWS calls. CDK signals offline synth by exporting dummy
// CDK_DEFAULT_ACCOUNT/CDK_DEFAULT_REGION, so we prefer those when present and
// fall back to the config account/region otherwise. The per-env config account
// still governs the deploy target in CI, where these env vars carry the real
// account id for the selected environment. resolveTarget fails synth when they point
// at a different region or a different real account than the selected env.
const env: cdk.Environment = resolveTarget(config);

// Tag everything with the environment for cost allocation and traceability.
cdk.Tags.of(app).add('Project', 'dad');
cdk.Tags.of(app).add('Environment', config.env);

buildDadApp(app, config, env);

app.synth();
