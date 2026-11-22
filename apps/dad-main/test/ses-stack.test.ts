import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildGraph } from './helpers';

describe('SesStack', () => {
  it('creates an SES domain identity for the sending subdomain (Easy DKIM)', () => {
    const t = Template.fromStack(buildGraph('staging').ses);
    // Identity.domain() enables Easy DKIM — surfaced as 3 CNAME token outputs
    // rather than a DkimAttributes property on the resource.
    t.resourceCountIs('AWS::SES::EmailIdentity', 1);
    t.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'mail.staging.dynamicaid.org',
    });
  });

  it('creates an IAM user with an SES sending policy', () => {
    const t = Template.fromStack(buildGraph('staging').ses);
    t.resourceCountIs('AWS::IAM::User', 1);
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ses:SendRawEmail',
            Condition: { StringEquals: { 'ses:FromAddress': 'no-reply@mail.staging.dynamicaid.org' } },
          }),
        ]),
      },
    });
  });

  it('removes the rotation log group with the stack only when deletion protection is off', () => {
    const policy = (env: 'staging' | 'production') =>
      Object.values(
        Template.fromStack(buildGraph(env).ses).findResources('AWS::Logs::LogGroup'),
      ).map((g) => g.DeletionPolicy);
    const staging = buildGraph('staging').config.deletionProtection;
    const production = buildGraph('production').config.deletionProtection;
    expect(policy('staging')).toEqual([staging ? 'Retain' : 'Delete']);
    expect(policy('production')).toEqual([production ? 'Retain' : 'Delete']);
  });

  it('stores a DONOR_SMTP_* secret', () => {
    const t = Template.fromStack(buildGraph('staging').ses);
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'dad/staging/ses/smtp',
    });
  });

  it('outputs DKIM records and a sandbox reminder', () => {
    const t = Template.fromStack(buildGraph('staging').ses);
    const outputs = t.findOutputs('*');
    const names = Object.keys(outputs);
    expect(names.some((n) => n.startsWith('DkimToken1'))).toBe(true);
    expect(names.some((n) => n.startsWith('SandboxReminder'))).toBe(true);
  });
});
