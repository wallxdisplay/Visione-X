import { describe, expect, it } from 'vitest';
import { appDealerPriceMinor, appReleaseStatus, catalogProblems, planScreenApps, type AppDoc } from './apps';
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

describe('apps per screen', () => {
  const catalog = [
    { id: 'screen', unit: 'screen' as const, featureKeys: ['media.basic' as const], base: true },
    { id: 'weather', unit: 'screen' as const, featureKeys: ['widget.weather' as const], base: false },
    { id: 'touch', unit: 'screen' as const, featureKeys: ['interactive.touch' as const], base: false },
    { id: 'api', unit: 'organization' as const, featureKeys: ['api.keys' as const], base: false },
  ];
  const screen = (id: string, apps: string[] = [], authorized = true) => ({ id, name: id, authorized, apps });
  const run = (over: Partial<Parameters<typeof planScreenApps>[0]>) =>
    planScreenApps({ appPricing: true, trialing: false, catalog, lines: [], screens: [], grants: [], ...over });

  it('blocks nothing with plan pricing or during the trial', () => {
    const screens = [screen('a', ['weather'])];
    for (const r of [run({ appPricing: false, screens }), run({ trialing: true, screens })]) {
      expect(r.get('a')).toEqual({ apps: ['weather'], blocked: [] });
    }
  });

  it('fills free seats by name and blocks the rest; the base app and organization apps are never blocked', () => {
    const r = run({ lines: [{ appId: 'weather', quantity: 2 }], screens: [screen('c'), screen('a'), screen('b'), screen('p', [], false)] });
    expect(r.get('a')).toEqual({ apps: ['weather'], blocked: ['interactive.touch'] });
    expect(r.get('b')!.apps).toEqual(['weather']);
    expect(r.get('c')).toEqual({ apps: [], blocked: ['interactive.touch', 'widget.weather'] });
    expect(r.get('p')!.apps).toEqual([]); // not authorized: holds no seat
  });

  it('keeps chosen holders, trims extras (last by name) and drops apps no longer bought', () => {
    const r = run({
      lines: [{ appId: 'weather', quantity: 1 }],
      screens: [screen('a'), screen('b', ['weather', 'touch']), screen('c', ['weather'])],
    });
    expect(r.get('a')!.apps).toEqual([]);
    expect(r.get('b')!.apps).toEqual(['weather']);
    expect(r.get('c')!.apps).toEqual([]);
  });

  it('a feature granted to the organization is usable on every screen', () => {
    const r = run({ screens: [screen('a')], grants: ['interactive.touch'] });
    expect(r.get('a')!.blocked).toEqual(['widget.weather']);
  });
});
