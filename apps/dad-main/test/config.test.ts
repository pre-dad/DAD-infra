import { getConfig } from '../lib/config';

describe('getConfig', () => {
  it('resolves staging with the exact account and hosts', () => {
    const c = getConfig('staging');
    expect(c.env).toBe('staging');
    expect(c.account).toBe('853377042897');
    expect(c.region).toBe('us-east-2');
    expect(c.publicHost).toBe('app.staging.dynamicaid.org');
    expect(c.staffHost).toBe('staff.staging.dynamicaid.org');
    expect(c.publicOrigin).toBe('https://app.staging.dynamicaid.org');
    expect(c.staffOrigin).toBe('https://staff.staging.dynamicaid.org');
    expect(c.sendingSubdomain).toBe('mail.staging.dynamicaid.org');
    expect(c.dbName).toBe('dad');
    expect(c.multiAz).toBe(false);
    expect(c.deletionProtection).toBe(false);
    expect(c.logRetentionDays).toBe(30);
    expect(c.desiredCounts).toEqual({ api: 1, web: 1, nginx: 1, workers: 1 });
  });

  it('resolves production with the exact account and hosts', () => {
    const c = getConfig('production');
    expect(c.env).toBe('production');
    expect(c.account).toBe('216833405626');
    expect(c.region).toBe('us-east-2');
    expect(c.publicHost).toBe('app.dynamicaid.org');
    expect(c.staffHost).toBe('staff.dynamicaid.org');
    expect(c.publicOrigin).toBe('https://app.dynamicaid.org');
    expect(c.staffOrigin).toBe('https://staff.dynamicaid.org');
    expect(c.sendingSubdomain).toBe('mail.dynamicaid.org');
    expect(c.dbName).toBe('dad');
    expect(c.multiAz).toBe(true);
    expect(c.deletionProtection).toBe(true);
    expect(c.logRetentionDays).toBeGreaterThan(30);
  });

  it('defaults to staging when env is undefined or empty', () => {
    expect(getConfig().env).toBe('staging');
    expect(getConfig('').env).toBe('staging');
  });

  it('is case-insensitive for the env selector', () => {
    expect(getConfig('STAGING').env).toBe('staging');
    expect(getConfig('Production').env).toBe('production');
  });

  it('throws on an unknown env', () => {
    expect(() => getConfig('qa')).toThrow(/Unknown env/);
  });

  it('origins are lowercase https with no trailing slash', () => {
    for (const name of ['staging', 'production'] as const) {
      const c = getConfig(name);
      for (const origin of [c.publicOrigin, c.staffOrigin]) {
        expect(origin).toMatch(/^https:\/\//);
        expect(origin).toBe(origin.toLowerCase());
        expect(origin.endsWith('/')).toBe(false);
      }
    }
  });

  it('sizes autoscaling at or above the desired counts, with a larger ceiling in production', () => {
    for (const name of ['staging', 'production'] as const) {
      const c = getConfig(name);
      expect(c.autoscaling.enabled).toBe(true);
      for (const svc of ['api', 'web', 'nginx'] as const) {
        expect(c.autoscaling[svc].maxCount).toBeGreaterThanOrEqual(c.desiredCounts[svc]);
      }
    }
    expect(getConfig('production').autoscaling.api.maxCount).toBeGreaterThan(
      getConfig('staging').autoscaling.api.maxCount,
    );
  });

  it('sizes staging for a few testers and leaves production unchanged', () => {
    const staging = getConfig('staging');
    expect(staging.database).toEqual({
      instanceType: 't4g.small',
      allocatedStorageGiB: 20,
      maxAllocatedStorageGiB: 200,
    });
    expect(staging.taskSizes.api).toEqual({ cpu: 256, memoryMiB: 512 });
    expect(staging.containerInsights).toBe(false);
    expect(staging.flowLogTrafficType).toBe('REJECT');

    const prod = getConfig('production');
    expect(prod.database.instanceType).toBe('t3.large');
    expect(prod.taskSizes.api).toEqual({ cpu: 1024, memoryMiB: 2048 });
    expect(prod.containerInsights).toBe(true);
    expect(prod.flowLogTrafficType).toBe('ALL');
  });

  it('keeps the interface endpoints off in staging and on in production', () => {
    expect(getConfig('staging').interfaceEndpointsEnabled).toBe(false);
    expect(getConfig('production').interfaceEndpointsEnabled).toBe(true);
  });
});
