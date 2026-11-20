import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EvidenceStack } from '../lib/evidence-stack';
import { getAtmConfig } from '../lib/atm-config';

function synth(env: 'staging' | 'production'): Template {
  const app = new cdk.App();
  const config = getAtmConfig(env);
  const stack = new EvidenceStack(app, `atm-evidence-${env}`, {
    env: { account: '111111111111', region: 'us-east-2' },
    config,
  });
  return Template.fromStack(stack);
}

describe('EvidenceStack', () => {
  test('blocks all public access', () => {
    const template = synth('staging');
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('enables SSE and versioning', () => {
    const template = synth('staging');
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          }),
        ]),
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  test('lifecycle expiry equals the config retention (staging 90d)', () => {
    const template = synth('staging');
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            ExpirationInDays: 90,
          }),
        ]),
      },
    });
  });

  test('lifecycle expiry equals the config retention (production 365d)', () => {
    const template = synth('production');
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Status: 'Enabled', ExpirationInDays: 365 }),
        ]),
      },
    });
  });

  test('cleans up incomplete uploads, old versions and delete markers', () => {
    const template = synth('production');
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            NoncurrentVersionExpiration: { NoncurrentDays: 365 },
          }),
          Match.objectLike({ ExpiredObjectDeleteMarker: true }),
        ]),
      },
    });
  });

  test('production retains the bucket; staging deletes it, emptying it first', () => {
    const prod = synth('production');
    expect(Object.values(prod.findResources('AWS::S3::Bucket'))[0].DeletionPolicy).toBe('Retain');
    prod.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
    const staging = synth('staging');
    expect(Object.values(staging.findResources('AWS::S3::Bucket'))[0].DeletionPolicy).toBe('Delete');
    staging.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  test('enforces TLS with a deny-insecure-transport bucket policy', () => {
    const template = synth('staging');
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });
});
