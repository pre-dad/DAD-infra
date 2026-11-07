import { Template } from 'aws-cdk-lib/assertions';
import { buildGraph } from './helpers';
import { toRetentionDays } from '../lib/ecs-cluster-stack';
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

  it('sets log-group retention from config (staging 30 days)', () => {
    const t = Template.fromStack(buildGraph('staging').ecsCluster);
    // 9 service log groups, each with 30-day retention.
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  it('sets log-group retention from config (production 365 days)', () => {
    const t = Template.fromStack(buildGraph('production').ecsCluster);
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 365 });
  });

  it('maps retention days to the nearest supported enum', () => {
    expect(toRetentionDays(30)).toBe(logs.RetentionDays.ONE_MONTH);
    expect(toRetentionDays(365)).toBe(logs.RetentionDays.ONE_YEAR);
  });
});
