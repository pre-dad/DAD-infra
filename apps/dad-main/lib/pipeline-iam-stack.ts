import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  GitHubOidcProvider,
  githubEnvironmentPrincipal,
} from '@dad-infra/pipeline-iam';
import { EnvConfig } from './config';
import { clusterNameFor } from './ecs-cluster-stack';
import { imageTagParameterName } from './image-tag';

/** The repo whose workflow runs `cdk deploy` for this app (dad-main-infra.yml). */
export const DAD_INFRA_REPO = 'pre-dad/DAD-infra';
/** The repo whose workflow rolls the application out (deploy.yml). */
export const DAD_MAIN_REPO = 'pre-dad/DAD-Main';

/** Props for {@link PipelineIamStack}. */
export interface PipelineIamStackProps extends cdk.StackProps {
  readonly config: EnvConfig;
  /**
   * GitHub `owner/repo` the infra-deploy role trusts. Falls back to CDK context
   * `infraRepo`, then {@link DAD_INFRA_REPO}.
   */
  readonly infraRepo?: string;
  /**
   * GitHub `owner/repo` the app-deploy role trusts. Falls back to CDK context
   * `appRepo`, then {@link DAD_MAIN_REPO}.
   */
  readonly appRepo?: string;
}

/**
 * PipelineIamStack.
 *
 * The GitHub Actions OIDC provider (token.actions.githubusercontent.com) and
 * two env-scoped deploy roles:
 *   - infra-deploy → runs `cdk deploy` for this env (infra pipeline).
 *   - app-deploy   → builds/pushes images and runs `aws ecs update-service`
 *                    (app pipeline).
 *
 * Each role trusts a different repo, because a different repo's workflow assumes it:
 *   - infra-deploy ← DAD-infra   (dad-main-infra.yml)
 *   - app-deploy   ← DAD-Main    (deploy.yml)
 * and each trusts exactly that repo's GitHub Environment (`staging` / `production`),
 * because every deploy job runs under one and GitHub then issues
 * `sub = repo:<repo>:environment:<env>`. Restrict which branches and tags may deploy
 * to those environments in the repository settings. Documented as a one-time
 * per-account apply.
 */
export class PipelineIamStack extends cdk.Stack {
  public readonly provider: iam.OpenIdConnectProvider;
  public readonly infraDeployRole: iam.Role;
  public readonly appDeployRole: iam.Role;

  constructor(scope: Construct, id: string, props: PipelineIamStackProps) {
    super(scope, id, props);

    const { config } = props;
    const infraRepo =
      props.infraRepo ??
      (this.node.tryGetContext('infraRepo') as string | undefined) ??
      DAD_INFRA_REPO;
    const appRepo =
      props.appRepo ??
      (this.node.tryGetContext('appRepo') as string | undefined) ??
      DAD_MAIN_REPO;

    // The account-level OIDC provider comes from the shared package so the two
    // DAD apps (dad-main, atm) do not each mint a colliding provider. The
    // construct id 'GitHubOidc' is preserved so the synthesized resource shape
    // is unchanged.
    this.provider = new GitHubOidcProvider(this, 'GitHubOidc').provider;

    // infra-deploy: allowed to assume the CDK bootstrap roles for cdk deploy.
    this.infraDeployRole = new iam.Role(this, 'InfraDeployRole', {
      roleName: `dad-${config.env}-infra-deploy`,
      assumedBy: githubEnvironmentPrincipal(this.provider, infraRepo, config.env),
      description: `GitHub OIDC infra (cdk deploy) role for ${config.env}.`,
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.infraDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${config.account}:role/cdk-*-deploy-role-*`,
          `arn:aws:iam::${config.account}:role/cdk-*-file-publishing-role-*`,
          `arn:aws:iam::${config.account}:role/cdk-*-image-publishing-role-*`,
          `arn:aws:iam::${config.account}:role/cdk-*-lookup-role-*`,
        ],
      }),
    );

    // app-deploy: build/push images to ECR + direct ECS deploy (scripts/deploy.sh).
    this.appDeployRole = new iam.Role(this, 'AppDeployRole', {
      roleName: `dad-${config.env}-app-deploy`,
      assumedBy: githubEnvironmentPrincipal(this.provider, appRepo, config.env),
      description: `GitHub OIDC app (ECR push + ecs update-service) role for ${config.env}.`,
      maxSessionDuration: cdk.Duration.hours(1),
    });
    const { region, account, env } = config;
    const arn = (service: string, resource: string): string =>
      `arn:aws:${service}:${service === 'iam' ? '' : region}:${account}:${resource}`;

    // docker login (aws-actions/amazon-ecr-login) needs the registry-wide token; the
    // action does not support resource-level permissions.
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrLogin',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    // `docker push` of dad/api, dad/web and dad/nginx, and nothing else in the registry.
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPush',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
          'ecr:BatchGetImage',
        ],
        resources: [arn('ecr', 'repository/dad/*')],
      }),
    );

    // The scripts' ECS calls (ecs-pin-image.sh, run-task.sh, ecs-rollout.sh):
    //   describe-task-definition, register-task-definition  (no resource-level support)
    //   run-task          -> the dad-maint-* task definitions, in this env's cluster only
    //   describe-tasks    -> this env's cluster's tasks (also `aws ecs wait tasks-stopped`)
    //   update-service, describe-services -> this env's cluster's services
    const cluster = clusterNameFor(env);
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsTaskDefinitions',
        actions: ['ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition'],
        resources: ['*'],
      }),
    );
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsRunMaintenanceTasks',
        actions: ['ecs:RunTask'],
        resources: [arn('ecs', 'task-definition/dad-maint-*:*')],
        conditions: {
          ArnEquals: { 'ecs:cluster': arn('ecs', `cluster/${cluster}`) },
        },
      }),
    );
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsDescribeTasks',
        actions: ['ecs:DescribeTasks'],
        resources: [arn('ecs', `task/${cluster}/*`)],
      }),
    );
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsRollServices',
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: [arn('ecs', `service/${cluster}/*`)],
      }),
    );
    // Registering (and running) a revision that names a task or execution role needs
    // PassRole on it. Those roles are generated by the services and maintenance stacks,
    // whose names start with the stack name; PipelineIamStack cannot reference them
    // directly because it must exist before either stack does.
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassTaskRoles',
        actions: ['iam:PassRole'],
        resources: [
          arn('iam', `role/dad-services-${env}-*`),
          arn('iam', `role/dad-maintenance-${env}-*`),
        ],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
        },
      }),
    );
    // After a successful rollout, deploy.yml records the release's image tag here so that
    // CDK (lib/image-tag.ts) always builds task definitions from the last good release.
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RecordImageTag',
        actions: ['ssm:PutParameter'],
        resources: [
          `arn:aws:ssm:${config.region}:${config.account}:parameter${imageTagParameterName(config.env)}`,
        ],
      }),
    );
    // DAD-Main's deploy.yml registers a task-definition revision per family pinned to the
    // release's image tag (scripts/ecs-pin-image.sh), copying the family's tags onto it.
    // Registering a revision WITH tags needs ecs:TagResource on the new revision.
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TagPinnedTaskDefinitions',
        actions: ['ecs:TagResource'],
        resources: [
          `arn:aws:ecs:${config.region}:${config.account}:task-definition/dad-*:*`,
        ],
      }),
    );
    // DAD-Main's deploy.yml resolves the cluster, compute subnets, and workers
    // security group from the CloudFormation outputs these stacks publish
    // (`aws cloudformation describe-stacks --stack-name dad-<name>-<env>`). Read-only,
    // and limited to this environment's dad-* stacks.
    this.appDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStackOutputs',
        actions: ['cloudformation:DescribeStacks'],
        resources: [
          `arn:aws:cloudformation:${config.region}:${config.account}:stack/dad-*-${config.env}/*`,
        ],
      }),
    );

    new cdk.CfnOutput(this, 'OidcProviderArn', {
      value: this.provider.openIdConnectProviderArn,
    });
    new cdk.CfnOutput(this, 'InfraDeployRoleArn', {
      value: this.infraDeployRole.roleArn,
    });
    new cdk.CfnOutput(this, 'AppDeployRoleArn', {
      value: this.appDeployRole.roleArn,
    });
  }
}
