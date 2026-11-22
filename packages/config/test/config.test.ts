import {
  getConfig,
  REGION,
  STAGING_ACCOUNT,
  PRODUCTION_ACCOUNT,
} from '../src/index';

describe('getConfig — shared DAD account/region map', () => {
  test('staging resolves the sandbox account and us-east-2', () => {
    const config = getConfig('staging');
    expect(config.env).toBe('staging');
    expect(config.account).toBe('853377042897');
    expect(config.account).toBe(STAGING_ACCOUNT);
    expect(config.region).toBe('us-east-2');
    expect(config.region).toBe(REGION);
  });

  test('production resolves the production account and us-east-2', () => {
    const config = getConfig('production');
    expect(config.env).toBe('production');
    expect(config.account).toBe('216833405626');
    expect(config.account).toBe(PRODUCTION_ACCOUNT);
    expect(config.region).toBe('us-east-2');
  });

  test('defaults to staging when env is undefined or empty', () => {
    expect(getConfig().env).toBe('staging');
    expect(getConfig('').env).toBe('staging');
    expect(getConfig('  ').env).toBe('staging');
    expect(getConfig('STAGING').env).toBe('staging');
  });

  test('trims and lowercases production', () => {
    expect(getConfig(' Production ').env).toBe('production');
  });

  test('returned configs are frozen', () => {
    expect(Object.isFrozen(getConfig('staging'))).toBe(true);
    expect(Object.isFrozen(getConfig('production'))).toBe(true);
  });

  test('throws on an unknown env with the exact message', () => {
    expect(() => getConfig('dev')).toThrow(
      "Unknown env 'dev'. Expected 'staging' or 'production' (default 'staging').",
    );
  });
});
