import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { LedgerStack, BY_STATUS_INDEX } from '../lib/ledger-stack';
import { getAtmConfig } from '../lib/atm-config';

function synth(env: 'staging' | 'production'): Template {
  const app = new cdk.App();
  const config = getAtmConfig(env);
  const stack = new LedgerStack(app, `atm-ledger-${env}`, {
    env: { account: '111111111111', region: 'us-east-2' },
    config,
  });
  return Template.fromStack(stack);
}

describe('LedgerStack', () => {
  test('production retains the table; staging deletes it', () => {
    expect(
      Object.values(synth('production').findResources('AWS::DynamoDB::Table'))[0].DeletionPolicy,
    ).toBe('Retain');
    expect(
      Object.values(synth('staging').findResources('AWS::DynamoDB::Table'))[0].DeletionPolicy,
    ).toBe('Delete');
  });

  test('key schema uses source (PK) + finding (SK), on-demand, PITR + SSE', () => {
    const template = synth('staging');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'atm-findings-staging',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'source', KeyType: 'HASH' },
        { AttributeName: 'finding', KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      SSESpecification: { SSEEnabled: true },
    });
  });

  test('defines the by-status GSI (PK source, SK status)', () => {
    const template = synth('staging');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: BY_STATUS_INDEX,
          KeySchema: [
            { AttributeName: 'source', KeyType: 'HASH' },
            { AttributeName: 'status', KeyType: 'RANGE' },
          ],
        }),
      ]),
    });
  });

  test('deletion protection toggles with env', () => {
    synth('staging').hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: false,
    });
    synth('production').hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: true,
    });
  });
});
