import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { AtmEnvConfig } from './atm-config';
import { BY_STATUS_INDEX } from './ledger-stack';

/**
 * Name of the optional environment variable that carries a GitHub token used to
 * clone DAD-Main. A caller of StartBuild may supply it per build; the project
 * definition holds only an empty placeholder, never a stored credential. EventBridge
 * Scheduler supplies none, so scheduled runs clone anonymously, which works only
 * while DAD-Main is a public repository.
 */
export const GITHUB_TOKEN_ENV_VAR = 'GITHUB_APP_TOKEN';

/** Props for {@link RunnerStack}. */
export interface RunnerStackProps extends cdk.StackProps {
  readonly config: AtmEnvConfig;
  /** The evidence bucket the runner writes artifacts into. */
  readonly evidenceBucket: s3.IBucket;
  /** The findings ledger table the runner reconciles into. */
  readonly findingsTable: dynamodb.ITable;
  /** The provider API-key secrets the runner may read when AI is enabled. */
  readonly secrets: secretsmanager.ISecret[];
}

/**
 * RunnerStack.
 *
 * The CodeBuild project `atm-runner-<env>` that runs an ATM acceptance pass.
 * Privileged (Docker-in-Docker) so ATM can build DAD-Main images and drive a
 * real browser. Source is the DAD-Main GitHub repo; an optional token supplied at
 * StartBuild time (modelled here as a placeholder env var) authenticates the
 * clone, so the project owns no stored GitHub credential.
 *
 * The service role is least-privilege: read only the `atm/<env>/*` secrets,
 * read/write only this env's evidence bucket, read + conditional-write only
 * this env's findings table and its GSI, and write only its own log group.
 * No `Resource: "*"` on S3, DynamoDB, or Secrets Manager.
 */
export class RunnerStack extends cdk.Stack {
  public readonly project: codebuild.Project;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: RunnerStackProps) {
    super(scope, id, props);

    const { config, evidenceBucket, findingsTable, secrets } = props;
    const projectName = `${config.prefix}-runner-${config.env}`;
    const [owner, repo] = config.githubRepo.split('/');

    this.logGroup = new logs.LogGroup(this, 'RunnerLogs', {
      logGroupName: `/aws/codebuild/${projectName}`,
      retention: logRetention(config.logRetentionDays),
      removalPolicy: config.deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // Least-privilege service role: no managed policies, explicit statements only.
    const role = new iam.Role(this, 'RunnerServiceRole', {
      roleName: `${projectName}-service`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: `Least-privilege service role for ${projectName}.`,
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OwnLogGroup',
        actions: [
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:CreateLogGroup',
        ],
        resources: [
          this.logGroup.logGroupArn,
          `${this.logGroup.logGroupArn}:*`,
        ],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadProviderSecrets',
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: secrets.map((s) => s.secretArn),
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EvidenceObjects',
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
        ],
        resources: [evidenceBucket.arnForObjects('*')],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EvidenceBucket',
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [evidenceBucket.bucketArn],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'FindingsLedger',
        actions: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [
          findingsTable.tableArn,
          `${findingsTable.tableArn}/index/${BY_STATUS_INDEX}`,
        ],
      }),
    );

    // The empty placeholder is not a secret. A StartBuild caller must override it with
    // type SECRETS_MANAGER or PARAMETER_STORE (the override default is PLAINTEXT).
    const environmentVariables: Record<string, codebuild.BuildEnvironmentVariable> = {
      [GITHUB_TOKEN_ENV_VAR]: {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: '',
      },
      ATM_ENV: {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: config.env,
      },
      ATM_EVIDENCE_BUCKET: {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: evidenceBucket.bucketName,
      },
      ATM_FINDINGS_TABLE: {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: findingsTable.tableName,
      },
    };

    this.project = new codebuild.Project(this, 'RunnerProject', {
      projectName,
      role,
      // The buildspec clones DAD-Main at the revision under validation
      // (--source-version from StartBuild, else the default branch).
      source: codebuild.Source.gitHub({
        owner,
        repo,
        // No webhook: runs are started explicitly via StartBuild (the schedule).
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: config.computeType,
        privileged: true,
      },
      environmentVariables,
      timeout: config.buildTimeout,
      logging: {
        cloudWatch: {
          logGroup: this.logGroup,
        },
      },
    });

    new cdk.CfnOutput(this, 'RunnerProjectName', {
      value: this.project.projectName,
      description: 'ATM CodeBuild runner project name.',
    });
    new cdk.CfnOutput(this, 'RunnerProjectArn', {
      value: this.project.projectArn,
      description: 'ATM CodeBuild runner project ARN.',
    });
  }
}

/** Map a retention-day count to the matching CloudWatch RetentionDays enum. */
export function logRetention(days: number): logs.RetentionDays {
  switch (days) {
    case 30:
      return logs.RetentionDays.ONE_MONTH;
    case 90:
      return logs.RetentionDays.THREE_MONTHS;
    case 365:
      return logs.RetentionDays.ONE_YEAR;
    default:
      throw new Error(`unsupported logRetentionDays: ${days}`);
  }
}
