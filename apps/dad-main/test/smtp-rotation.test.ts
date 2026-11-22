import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Template } from 'aws-cdk-lib/assertions';
import { MAIL_WORKER_SERVICES } from '../lib/ecs-cluster-stack';
import { buildGraph } from './helpers';

type Res = { Type: string; Properties: Record<string, any> };

describe('SMTP credential rotation', () => {
  // Standard: IaC never mints a long-lived credential; every credential has an automated
  // rotation path.
  it('creates no IAM access key in CloudFormation', () => {
    const t = Template.fromStack(buildGraph('staging').ses);
    expect(Object.keys(t.findResources('AWS::IAM::AccessKey'))).toEqual([]);
  });

  it('starts the secret with empty credentials and no value in the template', () => {
    const t = Template.fromStack(buildGraph('staging').ses);
    const secret = Object.values(t.findResources('AWS::SecretsManager::Secret') as Record<string, Res>)[0];
    expect(secret.Properties.SecretString).toBeUndefined();
    const fields = JSON.parse(secret.Properties.GenerateSecretString.SecretStringTemplate);
    expect(fields).toEqual({
      DONOR_SMTP_HOST: 'email-smtp.us-east-2.amazonaws.com',
      DONOR_SMTP_PORT: '587',
      DONOR_EMAIL_FROM: 'no-reply@mail.staging.dynamicaid.org',
      DONOR_SMTP_USERNAME: '',
      DONOR_SMTP_PASSWORD: '',
    });
  });

  it('rotates every 90 days, and immediately when created (the first credential)', () => {
    for (const env of ['staging', 'production'] as const) {
      const t = Template.fromStack(buildGraph(env).ses);
      const schedules = Object.values(t.findResources('AWS::SecretsManager::RotationSchedule') as Record<string, Res>);
      expect(schedules).toHaveLength(1);
      expect(schedules[0].Properties.RotateImmediatelyOnUpdate).toBe(true);
      expect(schedules[0].Properties.RotationRules).toEqual({ ScheduleExpression: 'rate(90 days)' });
      expect(JSON.stringify(schedules[0].Properties.RotationLambdaARN)).toContain('SmtpRotation');
    }
  });

  it('gives the function only the SMTP user\'s keys and the mail workers', () => {
    const { config, ses } = buildGraph('staging');
    const t = Template.fromStack(ses);
    const statements = Object.values(t.findResources('AWS::IAM::Policy') as Record<string, Res>)
      .filter((p) => JSON.stringify(p.Properties.Roles ?? []).includes('SmtpRotation'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<Record<string, any>>);
    const bySid = Object.fromEntries(statements.filter((s) => s.Sid).map((s) => [s.Sid, s]));
    expect(Object.keys(bySid).sort()).toEqual(['RestartMailWorkers', 'RotateSmtpUserKeys']);
    expect([...bySid.RotateSmtpUserKeys.Action].sort()).toEqual([
      'iam:CreateAccessKey',
      'iam:DeleteAccessKey',
      'iam:ListAccessKeys',
    ]);
    expect(JSON.stringify(bySid.RotateSmtpUserKeys.Resource)).toContain('SmtpUser');
    expect([...bySid.RestartMailWorkers.Resource].sort()).toEqual(
      [...MAIL_WORKER_SERVICES]
        .sort()
        .map((s) => `arn:aws:ecs:us-east-2:${config.account}:service/dad-staging/${s}`),
    );
    // No wildcard resource on IAM or ECS.
    for (const s of statements) {
      const actions = ([] as string[]).concat(s.Action);
      if (actions.some((a) => a.startsWith('iam:') || a.startsWith('ecs:'))) {
        expect(s.Resource).not.toBe('*');
      }
    }
  });

  it('restarts exactly the services that read the SMTP password', () => {
    const t = Template.fromStack(buildGraph('staging').services);
    const readers = Object.values(t.findResources('AWS::ECS::TaskDefinition') as Record<string, Res>)
      .filter((d) =>
        ((d.Properties.ContainerDefinitions[0].Secrets ?? []) as Array<{ Name: string }>).some(
          (s) => s.Name === 'DONOR_SMTP_PASSWORD',
        ),
      )
      .map((d) => d.Properties.Family.replace(/^dad-/, ''))
      .sort();
    expect(readers).toEqual([...MAIL_WORKER_SERVICES].sort());
  });

  it('ships the handler without the Python tests or bytecode caches', () => {
    const { app, ses } = buildGraph('staging', {}, { 'aws:cdk:enable-asset-metadata': 'true' });
    const t = Template.fromStack(ses);
    const fn = Object.values(t.findResources('AWS::Lambda::Function') as Record<string, Res>)[0];
    const assetDir = path.join(app.outdir, (fn as any).Metadata['aws:asset:path']);
    const staged = fs.readdirSync(assetDir);
    expect(staged).toContain('index.py');
    expect(staged).not.toContain('test_index.py');
    expect(staged).not.toContain('__pycache__');
    expect(fn.Properties.Runtime).toBe('python3.12');
    expect(fn.Properties.Handler).toBe('index.handler');
    expect(fn.Properties.Environment.Variables.MAIL_SERVICES).toBe(MAIL_WORKER_SERVICES.join(','));
  });

  // The function's own unit tests (fake AWS clients), run here so CI runs them.
  it('passes the rotation function\'s Python unit tests', () => {
    const dir = path.join(__dirname, '..', 'lambda', 'smtp-rotation');
    // execFileSync throws, with the unittest output, on a non-zero exit.
    execFileSync('python3', ['-m', 'unittest', 'test_index'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, 60_000);
});
