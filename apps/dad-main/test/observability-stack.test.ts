import { Template } from 'aws-cdk-lib/assertions';
import { SERVICE_NAMES } from '../lib/ecs-cluster-stack';
import { buildGraph } from './helpers';

describe('ObservabilityStack', () => {
  it('creates one SNS topic', () => {
    const t = Template.fromStack(buildGraph('staging').observability);
    t.resourceCountIs('AWS::SNS::Topic', 1);
  });

  it('alarms only the running services while workers are off', () => {
    const t = Template.fromStack(buildGraph('production').observability);
    // api, web, nginx + 2 database.
    t.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    const names = Object.values(t.findResources('AWS::CloudWatch::Alarm')).map(
      (a) => a.Properties.AlarmName,
    );
    expect(names.sort()).toEqual([
      'dad-production-DatabaseCpu',
      'dad-production-DatabaseFreeStorage',
      'dad-production-api-unhealthy',
      'dad-production-nginx-unhealthy',
      'dad-production-web-unhealthy',
    ]);
  });

  it('adds an alarm per worker service once workers are on', () => {
    const t = Template.fromStack(
      buildGraph('production', { workersEnabled: true }).observability,
    );
    t.resourceCountIs('AWS::CloudWatch::Alarm', 11);
    const names = Object.values(t.findResources('AWS::CloudWatch::Alarm')).map(
      (a) => a.Properties.AlarmName as string,
    );
    for (const worker of SERVICE_NAMES.filter((n) => !['api', 'web', 'nginx'].includes(n))) {
      expect(names).toContain(`dad-production-${worker}-unhealthy`);
    }
  });

  it('keeps only the database alarms where Container Insights is off (staging)', () => {
    const t = Template.fromStack(
      buildGraph('staging', { workersEnabled: true }).observability,
    );
    t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    const [topicId] = Object.keys(t.findResources('AWS::SNS::Topic'));
    for (const alarm of Object.values(t.findResources('AWS::CloudWatch::Alarm'))) {
      expect(alarm.Properties.AlarmActions).toEqual([{ Ref: topicId }]);
    }
    const metrics = Object.values(t.findResources('AWS::CloudWatch::Alarm')).map(
      (a) => a.Properties.MetricName,
    );
    expect(metrics).not.toContain('RunningTaskCount');
  });

  it('alarms on database CPU and free storage', () => {
    const t = Template.fromStack(buildGraph('staging').observability);
    for (const metricName of ['CPUUtilization', 'FreeStorageSpace']) {
      t.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: metricName,
        Namespace: 'AWS/RDS',
      });
    }
  });

  it('service-health alarms fire when running < desired', () => {
    const t = Template.fromStack(buildGraph('production').observability);
    const [topicId] = Object.keys(t.findResources('AWS::SNS::Topic'));
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      ComparisonOperator: 'LessThanThreshold',
      MetricName: 'RunningTaskCount',
      AlarmActions: [{ Ref: topicId }],
    });
  });

  it('has no alarm on a metric nothing publishes (the monitor task emits no queue-age metric)', () => {
    const t = Template.fromStack(buildGraph('staging').observability);
    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm'));
    for (const a of alarms) {
      expect(a.Properties.Namespace).not.toMatch(/Monitor/);
      expect(a.Properties.MetricName).not.toBe('QueueAgeSeconds');
    }
  });
});
