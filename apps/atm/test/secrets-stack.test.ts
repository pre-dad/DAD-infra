import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SecretsStack } from '../lib/secrets-stack';
import { getAtmConfig } from '../lib/atm-config';

function synth(env: 'staging' | 'production'): Template {
  const app = new cdk.App();
  const config = getAtmConfig(env);
  const stack = new SecretsStack(app, `atm-secrets-${env}`, {
    env: { account: '111111111111', region: 'us-east-2' },
    config,
  });
  return Template.fromStack(stack);
}

describe('SecretsStack', () => {
  test('creates exactly the two placeholder secrets with expected names', () => {
    const template = synth('staging');
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'atm/staging/openai',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'atm/staging/tinker',
    });
  });

  test('production secrets are namespaced per env', () => {
    const template = synth('production');
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'atm/production/openai',
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'atm/production/tinker',
    });
  });

  test('production retains the secrets and staging deletes them', () => {
    const prod = synth('production').findResources('AWS::SecretsManager::Secret');
    expect(Object.values(prod).map((r) => r.DeletionPolicy)).toEqual(['Retain', 'Retain']);
    const staging = synth('staging').findResources('AWS::SecretsManager::Secret');
    expect(Object.values(staging).map((r) => r.DeletionPolicy)).toEqual(['Delete', 'Delete']);
  });

  test('no rotation schedule is configured', () => {
    const template = synth('staging');
    template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
  });
});
