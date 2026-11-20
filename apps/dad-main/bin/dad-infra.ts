#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { getConfig } from '../lib/config';
import { buildDadApp } from '../lib/dad-app';
import { resolveTarget } from '../lib/target-env';

/**
 * DAD infrastructure CDK app entrypoint. Select the environment with
 * `-c env=staging|production` (default staging); the stack graph is in lib/dad-app.ts.
 */
const app = new cdk.App();

const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'staging';
const config = getConfig(envName);

// CDK_DEFAULT_ACCOUNT/REGION enable offline synth; see lib/target-env.ts.
const env: cdk.Environment = resolveTarget(config);

// Tag everything with the environment for cost allocation and traceability.
cdk.Tags.of(app).add('Project', 'dad');
cdk.Tags.of(app).add('Environment', config.env);

buildDadApp(app, config, env);

app.synth();
