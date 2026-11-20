import { ComputeType } from 'aws-cdk-lib/aws-codebuild';
import { getAtmConfig, DAD_MAIN_REPO, RESOURCE_PREFIX } from '../lib/atm-config';

describe('getAtmConfig', () => {
  test('staging inherits the sandbox account + us-east-2 and sets staging overrides', () => {
    const config = getAtmConfig('staging');
    expect(config.env).toBe('staging');
    expect(config.account).toBe('853377042897');
    expect(config.region).toBe('us-east-2');
    expect(config.prefix).toBe(RESOURCE_PREFIX);
    expect(config.evidenceRetentionDays).toBe(90);
    expect(config.deletionProtection).toBe(false);
    expect(config.computeType).toBe(ComputeType.MEDIUM);
    expect(config.githubRepo).toBe(DAD_MAIN_REPO);
  });

  test('production inherits the production account and sets production overrides', () => {
    const config = getAtmConfig('production');
    expect(config.env).toBe('production');
    expect(config.account).toBe('216833405626');
    expect(config.evidenceRetentionDays).toBe(365);
    expect(config.deletionProtection).toBe(true);
    expect(config.computeType).toBe(ComputeType.LARGE);
  });

  test('defaults to staging and throws on an unknown env (delegated to shared config)', () => {
    expect(getAtmConfig().env).toBe('staging');
    expect(() => getAtmConfig('dev')).toThrow(
      "Unknown env 'dev'. Expected 'staging' or 'production' (default 'staging').",
    );
  });
});
