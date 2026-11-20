import { Template } from 'aws-cdk-lib/assertions';
import { buildGraph } from './helpers';
import { SERVICE_NAMES, toRetentionDays } from '../lib/ecs-cluster-stack';
import * as logs from 'aws-cdk-lib/aws-logs';

describe('EcsClusterStack', () => {
  it('creates exactly 3 ECR repositories (dad/api, dad/web, dad/nginx)', () => {
    const t = Template.fromStack(buildGraph('staging').ecsCluster);
    t.resourceCountIs('AWS::ECR::Repository', 3);
    for (const name of ['dad/api', 'dad/web', 'dad/nginx']) {
      t.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryName: name,
      });
    }
  });

  it('creates one Fargate cluster with a Service Connect namespace', () => {
    const t = Template.fromStack(buildGraph('staging').ecsCluster);
    t.resourceCountIs('AWS::ECS::Cluster', 1);
    t.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 1);
  });

  it('turns Container Insights on in production and off in staging', () => {
    const setting = (env: 'staging' | 'production') =>
      Object.values(
        Template.fromStack(buildGraph(env).ecsCluster).findResources('AWS::ECS::Cluster'),
      )[0].Properties.ClusterSettings;
    expect(setting('production')).toEqual([{ Name: 'containerInsights', Value: 'enabled' }]);
    expect(setting('staging')).toEqual([{ Name: 'containerInsights', Value: 'disabled' }]);
  });

  it.each([
    ['staging', 30],
    ['production', 365],
  ] as const)('gives every %s service log group %i-day retention', (env, days) => {
    const groups = Object.values(
      Template.fromStack(buildGraph(env).ecsCluster).findResources('AWS::Logs::LogGroup'),
    );
    expect(groups).toHaveLength(SERVICE_NAMES.length);
    for (const g of groups) {
      expect(g.Properties.RetentionInDays).toBe(days);
    }
  });

  it('maps retention days to the matching enum and rejects unsupported counts', () => {
    expect(toRetentionDays(30)).toBe(logs.RetentionDays.ONE_MONTH);
    expect(toRetentionDays(365)).toBe(logs.RetentionDays.ONE_YEAR);
    expect(() => toRetentionDays(45)).toThrow(/unsupported log retention: 45/);
  });
});
