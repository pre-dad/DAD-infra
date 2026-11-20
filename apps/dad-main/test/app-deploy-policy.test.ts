import { Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config';
import { buildGraph } from './helpers';

const ACCOUNTS = (['staging', 'production'] as const).map(
  (env) => [env, getConfig(env).account] as const,
);

interface Statement {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: unknown;
}

/** Every statement attached to the app-deploy role. */
function appDeployStatements(env: 'staging' | 'production'): Statement[] {
  const t = Template.fromStack(buildGraph(env).pipelineIam);
  const policies = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
    JSON.stringify(p.Properties.Roles).includes('AppDeployRole'),
  );
  return policies.flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
}

function statement(list: Statement[], sid: string): Statement {
  const found = list.filter((s) => s.Sid === sid);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('app-deploy role least privilege', () => {
  it('uses a wildcard resource only where AWS offers no resource-level form', () => {
    for (const [env] of ACCOUNTS) {
      const wildcard = appDeployStatements(env)
        .filter((s) => [s.Resource].flat().includes('*'))
        .map((s) => s.Sid)
        .sort();
      expect(wildcard).toEqual(['EcrLogin', 'EcsTaskDefinitions']);
    }
  });

  it('limits the ECR actions to the dad/* repositories', () => {
    for (const [env, account] of ACCOUNTS) {
      const list = appDeployStatements(env);
      expect(statement(list, 'EcrLogin').Action).toEqual('ecr:GetAuthorizationToken');
      const push = statement(list, 'EcrPush');
      expect(push.Resource).toBe(`arn:aws:ecr:us-east-2:${account}:repository/dad/*`);
      expect(push.Action).toEqual(
        expect.arrayContaining(['ecr:PutImage', 'ecr:UploadLayerPart', 'ecr:InitiateLayerUpload']),
      );
      expect(JSON.stringify(list)).not.toContain('"ecr:*"');
    }
  });

  it("scopes ECS calls to this env's cluster, services and maintenance task definitions", () => {
    for (const [env, account] of ACCOUNTS) {
      const list = appDeployStatements(env);
      const base = `arn:aws:ecs:us-east-2:${account}`;
      expect(JSON.stringify(list)).not.toContain('"ecs:*"');

      expect(statement(list, 'EcsTaskDefinitions').Action).toEqual([
        'ecs:DescribeTaskDefinition',
        'ecs:RegisterTaskDefinition',
      ]);
      const run = statement(list, 'EcsRunMaintenanceTasks');
      expect(run.Action).toBe('ecs:RunTask');
      expect(run.Resource).toBe(`${base}:task-definition/dad-maint-*:*`);
      expect(run.Condition).toEqual({
        ArnEquals: { 'ecs:cluster': `${base}:cluster/dad-${env}` },
      });
      expect(statement(list, 'EcsDescribeTasks').Resource).toBe(`${base}:task/dad-${env}/*`);
      const roll = statement(list, 'EcsRollServices');
      expect(roll.Action).toEqual(['ecs:UpdateService', 'ecs:DescribeServices']);
      expect(roll.Resource).toBe(`${base}:service/dad-${env}/*`);
    }
  });

  it('allows iam:PassRole only on the services and maintenance task roles, only to ECS tasks', () => {
    for (const [env, account] of ACCOUNTS) {
      const pass = appDeployStatements(env).filter((s) =>
        [s.Action].flat().includes('iam:PassRole'),
      );
      expect(pass).toHaveLength(1);
      expect(pass[0].Sid).toBe('PassTaskRoles');
      expect(pass[0].Resource).toEqual([
        `arn:aws:iam::${account}:role/dad-services-${env}-*`,
        `arn:aws:iam::${account}:role/dad-maintenance-${env}-*`,
      ]);
      expect(pass[0].Condition).toEqual({
        StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
      });
    }
  });

  it('the PassRole patterns cover the roles the services and maintenance stacks generate', () => {
    for (const env of ['staging', 'production'] as const) {
      const g = buildGraph(env);
      expect(g.services.stackName.startsWith(`dad-services-${env}`)).toBe(true);
      expect(g.maintenance.stackName.startsWith(`dad-maintenance-${env}`)).toBe(true);
      // No explicit RoleName: CloudFormation prefixes generated names with the stack name.
      for (const stack of [g.services, g.maintenance]) {
        const roles = Template.fromStack(stack).findResources('AWS::IAM::Role');
        for (const r of Object.values(roles)) {
          expect(r.Properties.RoleName).toBeUndefined();
        }
      }
    }
  });
});
