import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { AtmEnvConfig } from './atm-config';

/** Props for {@link TriggerStack}. */
export interface TriggerStackProps extends cdk.StackProps {
  readonly config: AtmEnvConfig;
  /** The CodeBuild runner project the triggers start. */
  readonly project: codebuild.IProject;
  /** Cron/rate schedule for nightly/periodic runs. Defaults to nightly 07:00 UTC. */
  readonly scheduleExpression?: string;
}

/**
 * TriggerStack.
 *
 * Runs are started by EventBridge Scheduler (nightly/periodic). The scheduler's role
 * is scoped to `codebuild:StartBuild` on exactly this project. No AWS-side webhook or
 * public ingress.
 *
 * There is deliberately NO GitHub OIDC role for DAD-Main CI to start a run. DAD-Main
 * already has an ATM acceptance gate (atm.yml) with its own durable findings ledger,
 * and how AWS runs relate to that gate is undecided. Wiring CI to this runner before
 * that is settled would create a second, disconnected source of findings. This stack
 * also must not create a GitHub OIDC provider: an account holds only one, and
 * `apps/dad-main`'s pipeline-iam stack owns it.
 */
export class TriggerStack extends cdk.Stack {
  public readonly schedulerRole: iam.Role;

  constructor(scope: Construct, id: string, props: TriggerStackProps) {
    super(scope, id, props);

    const { config, project } = props;

    // Confused-deputy guard: only this account's EventBridge Scheduler, acting for this
    // stack's own schedule, may assume the role. The ARN is built from the schedule name
    // (not a reference to the schedule resource, which depends on this role).
    const scheduleName = `${config.prefix}-nightly-${config.env}`;
    const scheduleArn = `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/${scheduleName}`;

    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `${config.prefix}-scheduler-${config.env}`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnEquals: { 'aws:SourceArn': scheduleArn },
        },
      }),
      description: `Lets EventBridge Scheduler start the ${config.prefix} runner (${config.env}).`,
    });
    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StartRunnerBuild',
        actions: ['codebuild:StartBuild'],
        resources: [project.projectArn],
      }),
    );

    new scheduler.CfnSchedule(this, 'NightlySchedule', {
      name: scheduleName,
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: props.scheduleExpression ?? 'cron(0 7 * * ? *)',
      target: {
        arn: project.projectArn,
        roleArn: this.schedulerRole.roleArn,
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    new cdk.CfnOutput(this, 'RunnerProjectName', {
      value: project.projectName,
      description: 'ATM CodeBuild runner project name the schedule targets.',
    });
  }
}
