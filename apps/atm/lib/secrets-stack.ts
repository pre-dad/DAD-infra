import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { AtmEnvConfig } from './atm-config';

/** Props for {@link SecretsStack}. */
export interface SecretsStackProps extends cdk.StackProps {
  readonly config: AtmEnvConfig;
}

/**
 * SecretsStack.
 *
 * The provider API-key secrets for AI exploration: `atm/<env>/openai` and
 * `atm/<env>/tinker`. Created as empty placeholders (values filled out of
 * band), with no rotation. They enter the CodeBuild runner only when AI
 * exploration is explicitly enabled and never reach application containers.
 */
export class SecretsStack extends cdk.Stack {
  public readonly openai: secretsmanager.Secret;
  public readonly tinker: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id, props);

    const { config } = props;
    const removalPolicy = config.deletionProtection
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    this.openai = new secretsmanager.Secret(this, 'OpenAiKey', {
      secretName: `${config.prefix}/${config.env}/openai`,
      description: `OpenAI API key for ATM AI exploration (${config.env}).`,
      removalPolicy,
    });

    this.tinker = new secretsmanager.Secret(this, 'TinkerKey', {
      secretName: `${config.prefix}/${config.env}/tinker`,
      description: `Tinker API key for ATM AI exploration (${config.env}).`,
      removalPolicy,
    });

    new cdk.CfnOutput(this, 'OpenAiSecretArn', {
      value: this.openai.secretArn,
      description: 'ARN of the OpenAI key secret.',
    });
    new cdk.CfnOutput(this, 'TinkerSecretArn', {
      value: this.tinker.secretArn,
      description: 'ARN of the Tinker key secret.',
    });
  }
}
