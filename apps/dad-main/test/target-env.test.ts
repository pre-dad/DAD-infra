import { getConfig } from '../lib/config';
import { resolveTarget } from '../lib/target-env';

const STAGING = '853377042897';
const PRODUCTION = '216833405626';

describe('resolveTarget', () => {
  it('accepts the matching real account for each env', () => {
    expect(resolveTarget(getConfig('staging'), STAGING, 'us-east-2')).toEqual({
      account: STAGING,
      region: 'us-east-2',
    });
    expect(resolveTarget(getConfig('production'), PRODUCTION, 'us-east-2')).toEqual({
      account: PRODUCTION,
      region: 'us-east-2',
    });
  });

  it.each(['000000000000', '111111111111'])('accepts placeholder account %s for both envs', (a) => {
    for (const env of ['staging', 'production']) {
      expect(resolveTarget(getConfig(env), a, 'us-east-2')).toEqual({
        account: a,
        region: 'us-east-2',
      });
    }
  });

  it('rejects a real account that differs from the env, naming both', () => {
    expect(() => resolveTarget(getConfig('staging'), PRODUCTION, 'us-east-2')).toThrow(
      new RegExp(`expected ${STAGING} .* ${PRODUCTION}`),
    );
    expect(() => resolveTarget(getConfig('production'), STAGING, 'us-east-2')).toThrow(
      new RegExp(`expected ${PRODUCTION} .* ${STAGING}`),
    );
    expect(() => resolveTarget(getConfig('staging'), '123456789012', 'us-east-2')).toThrow(
      /Wrong account/,
    );
  });

  it('rejects a region mismatch for a real account', () => {
    expect(() => resolveTarget(getConfig('staging'), STAGING, 'us-east-1')).toThrow(
      /expected us-east-2 .* us-east-1/,
    );
    expect(() => resolveTarget(getConfig('production'), PRODUCTION, 'us-west-2')).toThrow(
      /Wrong region/,
    );
  });

  it('lets a placeholder account through whatever region the CLI substituted', () => {
    expect(resolveTarget(getConfig('staging'), '000000000000', 'us-east-1')).toEqual({
      account: '000000000000',
      region: 'us-east-1',
    });
  });

  it('falls back to the config values when the variables are unset', () => {
    expect(resolveTarget(getConfig('staging'), undefined, undefined)).toEqual({
      account: STAGING,
      region: 'us-east-2',
    });
    expect(resolveTarget(getConfig('production'), undefined, undefined)).toEqual({
      account: PRODUCTION,
      region: 'us-east-2',
    });
  });
});
