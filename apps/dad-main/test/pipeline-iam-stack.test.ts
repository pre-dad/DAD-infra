import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config';
import {
  DAD_INFRA_REPO,
  DAD_MAIN_REPO,
  PipelineIamStack,
} from '../lib/pipeline-iam-stack';
import { buildGraph } from './helpers';

const SUB = 'token.actions.githubusercontent.com:sub';
const AUD = 'token.actions.githubusercontent.com:aud';

/** The trust-policy condition of the single role named `roleName`. */
function trustCondition(t: Template, roleName: string): unknown {
  const roles = t.findResources('AWS::IAM::Role', {
    Properties: { RoleName: roleName },
  });
  const ids = Object.keys(roles);
  expect(ids).toHaveLength(1);
  const statements = roles[ids[0]].Properties.AssumeRolePolicyDocument.Statement;
  expect(statements).toHaveLength(1);
  return statements[0].Condition;
}

describe('PipelineIamStack', () => {
  it('creates the GitHub OIDC provider', () => {
    const t = Template.fromStack(buildGraph('staging').pipelineIam);
    t.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIDList: ['sts.amazonaws.com'],
    });
  });

  it('names the two deploy roles per environment', () => {
    for (const env of ['staging', 'production'] as const) {
      const t = Template.fromStack(buildGraph(env).pipelineIam);
      for (const name of [`dad-${env}-infra-deploy`, `dad-${env}-app-deploy`]) {
        t.hasResourceProperties('AWS::IAM::Role', { RoleName: name });
      }
    }
  });

  // Every deploy job runs under a GitHub Environment, so GitHub issues
  // sub = repo:<repo>:environment:<env> (not the branch or tag form). Each role
  // trusts exactly that, for exactly the repo whose workflow assumes it.
  it.each(['staging', 'production'] as const)(
    '%s: infra-deploy trusts only the DAD-infra repo\'s GitHub Environment',
    (env) => {
      const t = Template.fromStack(buildGraph(env).pipelineIam);
      expect(trustCondition(t, `dad-${env}-infra-deploy`)).toEqual({
        StringEquals: {
          [AUD]: 'sts.amazonaws.com',
          [SUB]: `repo:pre-dad/DAD-infra:environment:${env}`,
        },
      });
    },
  );

  it.each(['staging', 'production'] as const)(
    '%s: app-deploy trusts only the DAD-Main repo\'s GitHub Environment',
    (env) => {
      const t = Template.fromStack(buildGraph(env).pipelineIam);
      expect(trustCondition(t, `dad-${env}-app-deploy`)).toEqual({
        StringEquals: {
          [AUD]: 'sts.amazonaws.com',
          [SUB]: `repo:pre-dad/DAD-Main:environment:${env}`,
        },
      });
    },
  );

  it('defaults to the real repos and neither role trusts the other\'s repo', () => {
    expect(DAD_INFRA_REPO).toBe('pre-dad/DAD-infra');
    expect(DAD_MAIN_REPO).toBe('pre-dad/DAD-Main');
    const t = Template.fromStack(buildGraph('staging').pipelineIam);
    expect(JSON.stringify(trustCondition(t, 'dad-staging-infra-deploy'))).not.toContain(
      'DAD-Main',
    );
    expect(JSON.stringify(trustCondition(t, 'dad-staging-app-deploy'))).not.toContain(
      'DAD-infra',
    );
  });

  it('never uses a wildcard or branch/tag subject', () => {
    for (const env of ['staging', 'production'] as const) {
      const t = Template.fromStack(buildGraph(env).pipelineIam);
      for (const role of ['infra-deploy', 'app-deploy']) {
        const c = JSON.stringify(trustCondition(t, `dad-${env}-${role}`));
        expect(c).not.toContain('StringLike');
        expect(c).not.toContain('*');
        expect(c).not.toContain(':ref:');
      }
    }
  });

  it('accepts per-role repo overrides', () => {
    const app = new cdk.App();
    const stack = new PipelineIamStack(app, 'override', {
      env: { account: '111111111111', region: 'us-east-2' },
      config: getConfig('staging'),
      infraRepo: 'octo/infra',
      appRepo: 'octo/app',
    });
    const t = Template.fromStack(stack);
    expect(trustCondition(t, 'dad-staging-infra-deploy')).toEqual({
      StringEquals: {
        [AUD]: 'sts.amazonaws.com',
        [SUB]: 'repo:octo/infra:environment:staging',
      },
    });
    expect(trustCondition(t, 'dad-staging-app-deploy')).toEqual({
      StringEquals: {
        [AUD]: 'sts.amazonaws.com',
        [SUB]: 'repo:octo/app:environment:staging',
      },
    });
  });

  // The pipeline scripts call these ECS APIs: ecs-pin-image.sh (describe + register a
  // task definition), run-task.sh (run-task, describe-tasks), ecs-rollout.sh
  // (update-service, describe-services). A missing action fails the first real deploy.
  it('lets app-deploy do every ECS call the DAD-Main pipeline scripts make', () => {
    const t = Template.fromStack(buildGraph('staging').pipelineIam);
    const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes('AppDeployRole'),
    );
    expect(policies.length).toBeGreaterThan(0);
    const actions = policies
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>)
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    for (const needed of [
      'ecs:DescribeTaskDefinition',
      'ecs:RegisterTaskDefinition',
      'ecs:RunTask',
      'ecs:DescribeTasks',
      'ecs:UpdateService',
      'ecs:DescribeServices',
    ]) {
      expect(actions).toContain(needed);
    }
  });

  it('lets app-deploy record the deployed image tag in exactly this env\'s SSM parameter', () => {
    for (const env of ['staging', 'production'] as const) {
      const { account } = getConfig(env);
      const t = Template.fromStack(buildGraph(env).pipelineIam);
      t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'RecordImageTag',
              Effect: 'Allow',
              Action: 'ssm:PutParameter',
              Resource: `arn:aws:ssm:us-east-2:${account}:parameter/dad/${env}/image-tag`,
            }),
          ]),
        },
      });
    }
  });

  it('lets app-deploy tag only this env\'s dad-* task definition revisions it registers', () => {
    for (const env of ['staging', 'production'] as const) {
      const { account } = getConfig(env);
      const t = Template.fromStack(buildGraph(env).pipelineIam);
      t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'TagPinnedTaskDefinitions',
              Effect: 'Allow',
              Action: 'ecs:TagResource',
              Resource: `arn:aws:ecs:us-east-2:${account}:task-definition/dad-*:*`,
            }),
          ]),
        },
      });
    }
  });

  it('lets app-deploy read only this env\'s dad-* stack outputs (deploy.yml resolves names from them)', () => {
    for (const env of ['staging', 'production'] as const) {
      const { account } = getConfig(env);
      const t = Template.fromStack(buildGraph(env).pipelineIam);
      t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'ReadStackOutputs',
              Effect: 'Allow',
              Action: 'cloudformation:DescribeStacks',
              Resource: `arn:aws:cloudformation:us-east-2:${account}:stack/dad-*-${env}/*`,
            }),
          ]),
        },
        Roles: [{ Ref: Match.stringLikeRegexp('AppDeployRole') }],
      });
    }
  });
});
