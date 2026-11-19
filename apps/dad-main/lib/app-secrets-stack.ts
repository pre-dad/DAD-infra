import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { EnvConfig } from './config';

/** Props for {@link AppSecretsStack}. */
export interface AppSecretsStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
}

/** The JSON fields of each application secret. ECS injects each field as an env var. */
export const APP_SECRET_FIELDS = {
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  encryption: ['DONOR_EMAIL_ENCRYPTION_KEY', 'DONOR_CONTENT_ENCRYPTION_KEY'],
  tls: ['INGRESS_TLS_FULLCHAIN', 'INGRESS_TLS_PRIVKEY'],
  signIn: [
    'DONOR_SMS_PROVIDER',
    'DONOR_SMS_ACCOUNT_ID',
    'DONOR_SMS_AUTH_TOKEN',
    'DONOR_SMS_FROM',
    'DONOR_OIDC_MODE',
    'DONOR_OIDC_APPLE_CLIENT_ID',
    'DONOR_OIDC_GOOGLE_CLIENT_ID',
    'DONOR_OIDC_REQUIRE_NONCE',
  ],
  webOAuth: [
    'DONOR_OAUTH_APPLE_CLIENT_ID',
    'DONOR_OAUTH_APPLE_CLIENT_SECRET',
    'DONOR_OAUTH_GOOGLE_CLIENT_ID',
    'DONOR_OAUTH_GOOGLE_CLIENT_SECRET',
  ],
} as const;

/**
 * AppSecretsStack — the application secrets the services read at start.
 *
 * Each secret is a JSON object whose fields ECS injects as environment variables
 * (`ecs.Secret.fromSecretsManager(secret, field)`). CDK creates them with every field
 * present and empty, and NO value in the CloudFormation template: the JSON shape is a
 * `generateSecretString` template, which CloudFormation does not regenerate on later
 * updates. The real values are put in by an operator (docs/bootstrap.md) and are never
 * overwritten by a deploy.
 *
 * An empty field is the same as an unset variable in docker-compose.prod.yml: Stripe
 * stays unconfigured (the API requires both keys or neither) and the features that need
 * an encryption key answer 503. nginx does not start until the TLS fields are filled.
 *
 * Retained on stack deletion: losing an encryption key makes the data it protects
 * permanently unreadable.
 */
export class AppSecretsStack extends cdk.Stack {
  public readonly stripe: secretsmanager.Secret;
  public readonly encryption: secretsmanager.Secret;
  public readonly tls: secretsmanager.Secret;
  public readonly signIn: secretsmanager.Secret;
  public readonly webOAuth: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: AppSecretsStackProps) {
    super(scope, id, props);
    const { config } = props;

    const make = (
      logicalId: string,
      name: string,
      fields: readonly string[],
      description: string,
    ): secretsmanager.Secret => {
      const template = Object.fromEntries(fields.map((f) => [f, '']));
      const secret = new secretsmanager.Secret(this, logicalId, {
        secretName: `dad/${config.env}/${name}`,
        description,
        generateSecretString: {
          // The generated key only satisfies the API; it is never read.
          secretStringTemplate: JSON.stringify(template),
          generateStringKey: 'placeholder',
          passwordLength: 8,
        },
      });
      secret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      return secret;
    };

    this.stripe = make(
      'StripeSecret',
      'app/stripe',
      APP_SECRET_FIELDS.stripe,
      'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (set both or neither).',
    );
    this.encryption = make(
      'EncryptionSecret',
      'app/encryption',
      APP_SECRET_FIELDS.encryption,
      'DONOR_EMAIL_ENCRYPTION_KEY and DONOR_CONTENT_ENCRYPTION_KEY. Crown jewels: back up separately; losing one makes its data unreadable.',
    );
    this.tls = make(
      'IngressTlsSecret',
      'ingress/tls',
      APP_SECRET_FIELDS.tls,
      'nginx origin certificate chain and private key (PEM). nginx does not start without them.',
    );

    this.signIn = make(
      'SignInSecret',
      'app/sign-in',
      APP_SECRET_FIELDS.signIn,
      'Optional live SMS and OIDC API settings. Empty fields keep sign-in methods off; do not configure stubs.',
    );
    this.webOAuth = make(
      'WebOAuthSecret',
      'app/web-oauth',
      APP_SECRET_FIELDS.webOAuth,
      'Optional browser OAuth exchange credentials. Empty fields keep browser social sign-in off.',
    );

    for (const [id, s] of [
      ['StripeSecretArn', this.stripe],
      ['EncryptionSecretArn', this.encryption],
      ['IngressTlsSecretArn', this.tls],
      ['SignInSecretArn', this.signIn],
      ['WebOAuthSecretArn', this.webOAuth],
    ] as const) {
      new cdk.CfnOutput(this, id, { value: s.secretArn });
    }
  }
}
