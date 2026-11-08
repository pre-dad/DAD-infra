import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { EnvConfig } from './config';
import { clusterNameFor, MAIL_WORKER_SERVICES, toRetentionDays } from './ecs-cluster-stack';

/** Props for {@link SesStack}. */
export interface SesStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
}

/**
 * SesStack.
 *
 * An SES domain identity for config.sendingSubdomain with Easy DKIM enabled, an
 * IAM user whose only permission is `ses:SendRawEmail` (SMTP sending), and a
 * Secrets Manager secret holding the DONOR_SMTP_* values. CfnOutputs surface the
 * DKIM/verification DNS records the operator adds in Cloudflare, plus a
 * sandbox-mode reminder.
 *
 * Credentials are never minted by CloudFormation. A Secrets Manager rotation function
 * (lambda/smtp-rotation) creates the IAM access key, derives the SES SMTP password from
 * it with AWS's documented algorithm, proves it with an SMTP login, and restarts the mail
 * workers. It runs once when the stack is created and every 90 days after. The previous
 * key stays valid until the next rotation, for tasks that started before this one.
 */
export class SesStack extends cdk.Stack {
  public readonly identity: ses.EmailIdentity;
  public readonly smtpUser: iam.User;
  public readonly smtpSecret: secretsmanager.Secret;
  public readonly rotationFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: SesStackProps) {
    super(scope, id, props);

    const { config } = props;
    const subdomain = config.sendingSubdomain;

    // Domain identity with Easy DKIM (3 CNAME records the operator publishes).
    this.identity = new ses.EmailIdentity(this, 'SendingIdentity', {
      identity: ses.Identity.domain(subdomain),
    });

    // IAM user restricted to SES sending only.
    this.smtpUser = new iam.User(this, 'SmtpUser', {
      userName: `dad-${config.env}-ses-smtp`,
    });
    this.smtpUser.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendRawEmail', 'ses:SendEmail'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'ses:FromAddress': `no-reply@${subdomain}` },
        },
      }),
    );

    // DONOR_SMTP_* secret. SMTP endpoint for this region; port 587 (STARTTLS). The
    // username and password start empty and are filled by the first rotation; the
    // template carries no credential.
    this.smtpSecret = new secretsmanager.Secret(this, 'SmtpSecret', {
      secretName: `dad/${config.env}/ses/smtp`,
      removalPolicy: config.deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      description:
        'DONOR_SMTP_* values for SES. Username/password are set by the rotation function (lambda/smtp-rotation).',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          DONOR_SMTP_HOST: `email-smtp.${config.region}.amazonaws.com`,
          DONOR_SMTP_PORT: '587',
          DONOR_EMAIL_FROM: `no-reply@${subdomain}`,
          DONOR_SMTP_USERNAME: '',
          DONOR_SMTP_PASSWORD: '',
        }),
        // Satisfies the API; the rotation function drops it.
        generateStringKey: 'placeholder',
        passwordLength: 8,
      },
    });

    // --- Rotation: the only thing that creates SMTP credentials -------------
    const cluster = clusterNameFor(config.env);
    this.rotationFunction = new lambda.Function(this, 'SmtpRotation', {
      functionName: `dad-${config.env}-smtp-rotation`,
      description: 'Rotates the SES SMTP credentials in dad/<env>/ses/smtp.',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'smtp-rotation'), {
        exclude: ['test_*.py', '__pycache__'],
      }),
      // The SMTP login retries for up to ~2 minutes while a new IAM key propagates.
      timeout: cdk.Duration.minutes(5),
      environment: {
        SMTP_USER_NAME: this.smtpUser.userName,
        SES_REGION: config.region,
        CLUSTER_NAME: cluster,
        MAIL_SERVICES: MAIL_WORKER_SERVICES.join(','),
      },
      logGroup: new logs.LogGroup(this, 'SmtpRotationLogs', {
        logGroupName: `/dad/${config.env}/smtp-rotation`,
        retention: toRetentionDays(config.logRetentionDays),
      }),
    });
    this.rotationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RotateSmtpUserKeys',
        actions: ['iam:ListAccessKeys', 'iam:CreateAccessKey', 'iam:DeleteAccessKey'],
        resources: [this.smtpUser.userArn],
      }),
    );
    this.rotationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RestartMailWorkers',
        actions: ['ecs:DescribeServices', 'ecs:UpdateService'],
        resources: MAIL_WORKER_SERVICES.map(
          (s) => `arn:aws:ecs:${config.region}:${config.account}:service/${cluster}/${s}`,
        ),
      }),
    );
    this.smtpSecret.addRotationSchedule('Rotation', {
      rotationLambda: this.rotationFunction,
      automaticallyAfter: cdk.Duration.days(90),
      // Also rotate when the schedule is created: that is the first credential.
      rotateImmediatelyOnUpdate: true,
    });

    // --- Outputs: DKIM / verification records + sandbox reminder --------
    new cdk.CfnOutput(this, 'SendingDomain', { value: subdomain });
    new cdk.CfnOutput(this, 'DkimToken1', {
      value: this.identity.dkimDnsTokenName1,
      description: 'Cloudflare CNAME name #1 for Easy DKIM.',
    });
    new cdk.CfnOutput(this, 'DkimValue1', {
      value: this.identity.dkimDnsTokenValue1,
    });
    new cdk.CfnOutput(this, 'DkimToken2', {
      value: this.identity.dkimDnsTokenName2,
      description: 'Cloudflare CNAME name #2 for Easy DKIM.',
    });
    new cdk.CfnOutput(this, 'DkimValue2', {
      value: this.identity.dkimDnsTokenValue2,
    });
    new cdk.CfnOutput(this, 'DkimToken3', {
      value: this.identity.dkimDnsTokenName3,
      description: 'Cloudflare CNAME name #3 for Easy DKIM.',
    });
    new cdk.CfnOutput(this, 'DkimValue3', {
      value: this.identity.dkimDnsTokenValue3,
    });
    new cdk.CfnOutput(this, 'SmtpSecretArn', {
      value: this.smtpSecret.secretArn,
      description: 'Secrets Manager ARN holding the DONOR_SMTP_* values.',
    });
    new cdk.CfnOutput(this, 'SandboxReminder', {
      value:
        'SES starts in SANDBOX mode: only verified recipients receive mail. Request production sending access before the public test.',
    });
  }
}
