import { describe, expect, it } from 'vitest';
import { resolveEntitlements, withinLimit, type Limits } from './features';

const limits: Limits = {
  screens: 5,
  users: 3,
  storageGB: 10,
  sensorDevices: 0,
  retentionDays: 30,
  apiCallsPerDay: null,
};

describe('resolveEntitlements', () => {
  it('drops planned features even if the plan lists them', () => {
    const result = resolveEntitlements({
      planFeatures: ['media.basic', 'reseller.portal'],
      planLimits: limits,
      catalog: { 'media.basic': 'ga', 'reseller.portal': 'planned' },
    });
    expect(result.features).toEqual(['media.basic']);
  });

  it('applies grant, revoke and limit overrides', () => {
    const result = resolveEntitlements({
      planFeatures: ['media.basic', 'widget.rss'],
      planLimits: limits,
      catalog: { 'media.basic': 'ga', 'widget.rss': 'ga', 'sensor.esp32': 'ga' },
      overrides: { grant: ['sensor.esp32'], revoke: ['widget.rss'], limits: { screens: 20 } },
    });
    expect(result.features).toEqual(['media.basic', 'sensor.esp32']);
    expect(result.limits.screens).toBe(20);
    expect(result.limits.users).toBe(3);
  });

  it('beta features need an explicit grant', () => {
    const base = { planLimits: limits, catalog: { 'api.keys': 'beta' as const } };
    expect(resolveEntitlements({ ...base, planFeatures: ['api.keys'] }).features).toEqual([]);
    expect(
      resolveEntitlements({ ...base, planFeatures: [], overrides: { grant: ['api.keys'] } }).features,
    ).toEqual(['api.keys']);
  });
});

describe('withinLimit', () => {
  it('treats null as unlimited', () => {
    expect(withinLimit(limits, 'apiCallsPerDay', 1_000_000)).toBe(true);
    expect(withinLimit(limits, 'screens', 6)).toBe(false);
  });
});
