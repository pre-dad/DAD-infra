import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  GitHubOidcProvider,
  githubEnvironmentPrincipal,
  githubEnvironmentSubject,
  scopedDeployRole,
  GITHUB_OIDC_URL,
  OIDC_AUDIENCE,
} from '../src/index';

describe('GitHubOidcProvider', () => {
  test('creates the provider with the GitHub issuer URL and STS audience', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new GitHubOidcProvider(stack, 'Oidc');

    const template = Template.fromStack(stack);
    template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: GITHUB_OIDC_URL,
      ClientIDList: [OIDC_AUDIENCE],
    });
  });
});

describe('githubEnvironmentSubject', () => {
  test('is the sub claim GitHub issues to a job under a GitHub Environment', () => {
    expect(githubEnvironmentSubject('pre-dad/DAD-infra', 'staging')).toBe(
      'repo:pre-dad/DAD-infra:environment:staging',
    );
    expect(githubEnvironmentSubject('pre-dad/DAD-Main', 'production')).toBe(
      'repo:pre-dad/DAD-Main:environment:production',
    );
  });
});

describe('githubEnvironmentPrincipal', () => {
  test('pins aud and an exact (non-wildcard) sub, with no StringLike', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const oidc = new GitHubOidcProvider(stack, 'Oidc');
    new iam.Role(stack, 'R', {
      roleName: 'env-role',
      assumedBy: githubEnvironmentPrincipal(oidc.provider, 'pre-dad/DAD-infra', 'production'),
    });
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'env-role',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': OIDC_AUDIENCE,
                'token.actions.githubusercontent.com:sub':
                  'repo:pre-dad/DAD-infra:environment:production',
              },
            },
          }),
        ],
      },
    });
  });
});

describe('scopedDeployRole', () => {
  test('trusts exactly the repo\'s GitHub Environment: aud pinned, exact sub, no wildcard', () => {
    for (const env of ['staging', 'production'] as const) {
      const app = new App();
      const stack = new Stack(app, 'TestStack');
      const oidc = new GitHubOidcProvider(stack, 'Oidc');
      scopedDeployRole(stack, 'DeployRole', {
        provider: oidc.provider,
        repo: 'pre-dad/DAD-Main',
        env,
        roleName: 'test-deploy',
      });
      Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'test-deploy',
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': OIDC_AUDIENCE,
                  'token.actions.githubusercontent.com:sub': `repo:pre-dad/DAD-Main:environment:${env}`,
                },
              },
            }),
          ],
        },
      });
    }
  });

  test('the package exports exactly the environment-trust API', () => {
    expect(Object.keys(require('../src/index')).sort()).toEqual([
      'GITHUB_OIDC_HOST',
      'GITHUB_OIDC_URL',
      'GitHubOidcProvider',
      'OIDC_AUDIENCE',
      'githubEnvironmentPrincipal',
      'githubEnvironmentSubject',
      'scopedDeployRole',
    ]);
  });
});
