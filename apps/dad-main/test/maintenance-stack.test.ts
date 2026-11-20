import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildGraph } from './helpers';

describe('MaintenanceStack', () => {
  it('defines 7 task definitions: 5 maintenance + reconcile + owner bootstrap', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    // migrate, provision-roles, staff, rekey, monitor, reconcile, bootstrap-owner.
    t.resourceCountIs('AWS::ECS::TaskDefinition', 7);
  });

  it('defines the exact maintenance commands', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    for (const cmd of [
      ['migrate'],
      ['provision'],
      ['staff'],
      ['rekey'],
      ['monitor'],
      ['reconcile'],
    ]) {
      t.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({ Command: cmd }),
        ]),
      });
    }
  });

  it('schedules reconcile at ~00:30 America/New_York', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(30 0 * * ? *)',
      ScheduleExpressionTimezone: 'America/New_York',
    });
  });

  // DAD-Main's pipeline registers a new task-definition revision per release, pinned to
  // the release's image tag. A schedule that names a fixed revision would keep running the
  // CDK-created one with the placeholder image.
  it('schedules the reconcile FAMILY (no revision), so the latest active revision runs', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    const schedules = Object.values(t.findResources('AWS::Scheduler::Schedule'));
    expect(schedules).toHaveLength(1);
    const arn = JSON.stringify(schedules[0].Properties.Target.EcsParameters.TaskDefinitionArn);
    expect(arn).toContain('task-definition/dad-maint-reconcile');
    // Ends at the family name: no ":<revision>", and not a reference to the one specific
    // CDK-created task definition resource (a Ref to that resolves to a revisioned ARN).
    expect(arn).toMatch(/task-definition\/dad-maint-reconcile"(\]\]\})?$/);
    expect(arn).not.toContain('maintreconcileTaskDef');
  });

  it('lets the scheduler run any revision of the reconcile family, only on this cluster', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'RunLatestReconcileRevision',
            Effect: 'Allow',
            Action: 'ecs:RunTask',
            Condition: { ArnEquals: { 'ecs:cluster': { 'Fn::ImportValue': Match.stringLikeRegexp('^dad-ecs-cluster-staging:') } } },
          }),
        ]),
      },
    });
    const policies = Object.values(t.findResources('AWS::IAM::Policy'));
    const statement = policies
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Resource: unknown }>)
      .find((s) => s.Sid === 'RunLatestReconcileRevision');
    expect(JSON.stringify(statement?.Resource)).toContain('task-definition/dad-maint-reconcile:*');
  });

  it('alarms on a non-zero reconcile exit and notifies the shared alarm topic', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    t.resourceCountIs('AWS::SNS::Topic', 0);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'dad-staging-reconcile-nonzero-exit',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: [{ 'Fn::ImportValue': Match.stringLikeRegexp('^dad-observability-staging:') }],
    });
  });

  it('alerts when a reconcile task stops non-zero or never starts, even with no logs', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: Match.objectLike({
          lastStatus: ['STOPPED'],
          $or: [
            { containers: { exitCode: [{ 'anything-but': 0 }] } },
            { stopCode: ['TaskFailedToStart'] },
          ],
        }),
      }),
      Targets: [Match.objectLike({ Arn: Match.anyValue() })],
    });
  });

  it('retries a failed schedule invocation twice and dead-letters it', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      Target: Match.objectLike({
        RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
        DeadLetterConfig: { Arn: Match.anyValue() },
      }),
    });
    t.resourceCountIs('AWS::SQS::Queue', 1);
  });

  it('only lets schedules from this account assume the scheduler role', () => {
    const t = Template.fromStack(buildGraph('staging').maintenance);
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'scheduler.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': '111111111111' },
              ArnLike: { 'aws:SourceArn': Match.anyValue() },
            },
          }),
        ],
      },
    });
  });
});
