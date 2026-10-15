import { describe, expect, it } from 'vitest';
import { appDealerPriceMinor, appReleaseStatus, catalogProblems, type AppDoc } from './apps';
import { FEATURE_KEYS } from './features';

const app = (id: string, featureKeys: AppDoc['featureKeys'], over: Partial<AppDoc> = {}) => ({ id, name: id, featureKeys, requires: [], base: false, active: true, ...over });

describe('app catalog rules', () => {
  it('an app is as released as its least released feature', () => {
    const catalog = { 'api.keys': 'ga', 'api.webhooks': 'beta' } as const;
    expect(appReleaseStatus({ featureKeys: ['api.keys', 'api.webhooks'] }, catalog)).toBe('beta');
    expect(appReleaseStatus({ featureKeys: ['api.keys'] }, catalog)).toBe('ga');
    expect(appReleaseStatus({ featureKeys: ['sensor.mqtt'] }, catalog)).toBe('planned');
    expect(appReleaseStatus({ featureKeys: [] }, catalog)).toBe('ga'); // e.g. extra storage
  });

  it('finds unsold and doubly sold features, unknown dependencies and circles', () => {
    const p = catalogProblems([
      app('a', ['widget.weather', 'widget.rss'], { requires: ['b'] }),
      app('b', ['widget.rss'], { requires: ['a'] }),
      app('c', [], { requires: ['nope'] }),
      app('s', ['media.basic'], { base: true }),
    ]);
    expect(p.duplicated).toEqual([{ feature: 'widget.rss', apps: ['a', 'b'] }]);
    expect(p.missingRequires).toEqual([{ app: 'c', requires: 'nope' }]);
    expect(p.cycles.sort()).toEqual(['a', 'b']);
    expect(p.baseCount).toBe(1);
    expect(p.unsold).toContain('sensor.mqtt');
    expect(p.unsold).not.toContain('reseller.portal'); // never sold as an app
    expect(p.unsold.length).toBe(FEATURE_KEYS.length - 1 - 3);
  });

  it('dealer price: fixed when set, else the reseller discount', () => {
    expect(appDealerPriceMinor({ priceMinor: 4_900, dealerPriceMinor: null }, 2_000)).toBe(3_920);
    expect(appDealerPriceMinor({ priceMinor: 4_900, dealerPriceMinor: 3_000 }, 2_000)).toBe(3_000);
  });
});
