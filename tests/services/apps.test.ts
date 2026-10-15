import { beforeEach, describe, expect, it } from 'vitest';
import { catalogProblems, paths, type AppCostDoc, type AppDoc, type AuditDoc } from '@wallx-play/shared';
import * as catalog from '../../functions/src/apps/catalog';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const billingStaff = user('bill', { platformRole: 'billing' });
const apps = async () => (await db.collection(paths.apps()).get()).docs.map((d) => d.data() as AppDoc);
const input = (over: Record<string, unknown> = {}) => ({
  id: 'weather',
  isNew: false,
  name: 'Weather & air quality',
  description: 'Weather and AQI widgets.',
  unit: 'screen' as const,
  featureKeys: ['widget.weather' as const],
  requires: [],
  base: false,
  storageGBPerUnit: null,
  priceMinor: 7_900,
  dealerPriceMinor: null,
  costMinor: 2_784,
  costNote: 'AQI is the main cost',
  active: true,
  sortOrder: 10,
  reason: 'AQI costs more in India',
  ...over,
});

beforeEach(async () => {
  await resetEmulator();
});

describe('app catalog', () => {
  it('starts with a complete catalog: every sold feature in exactly one app', async () => {
    const list = await apps();
    expect(list).toHaveLength(13);
    const p = catalogProblems(list);
    expect(p).toMatchObject({ unsold: [], duplicated: [], missingRequires: [], cycles: [], baseCount: 1 });
    expect(list.find((a) => a.id === 'screen')).toMatchObject({ base: true, unit: 'screen', priceMinor: 29_900 });
    expect(((await db.doc(paths.appCost('sensors')).get()).data() as AppCostDoc).costMinor).toBe(8_108);
  });

  it('billing staff change prices with an audited reason; the catalog stays consistent', async () => {
    await expectCode(catalog.saveApp(deps, user('alice'), input()), 'permission-denied');
    await catalog.saveApp(deps, billingStaff, input());
    expect((await db.doc(paths.app('weather')).get()).data()).toMatchObject({ priceMinor: 7_900, updatedBy: 'bill' });
    expect((await db.doc(paths.appCost('weather')).get()).data()).toMatchObject({ costMinor: 2_784, note: 'AQI is the main cost' });
    const audit = (await db.collection(paths.auditLogs()).where('action', '==', 'app.updated').get()).docs.map((d) => d.data() as AuditDoc);
    expect(audit[0]).toMatchObject({ reason: 'AQI costs more in India', data: { from: { priceMinor: 4_900 }, to: { priceMinor: 7_900 } } });

    // A feature sold twice, unknown dependencies, circles and a second base app are refused.
    await expectCode(catalog.saveApp(deps, billingStaff, input({ featureKeys: ['widget.weather', 'widget.rss'] })), 'failed-precondition');
    await expectCode(catalog.saveApp(deps, billingStaff, input({ requires: ['nope'] })), 'invalid-argument');
    await catalog.saveApp(deps, billingStaff, input({ requires: ['news'] }));
    await expectCode(catalog.saveApp(deps, billingStaff, input({ id: 'news', name: 'News (RSS)', featureKeys: ['widget.rss'], requires: ['weather'] })), 'invalid-argument');
    await expectCode(catalog.saveApp(deps, billingStaff, input({ base: true })), 'failed-precondition');

    // New apps need a new id; existing ids cannot be created twice.
    await expectCode(catalog.saveApp(deps, billingStaff, input({ isNew: true })), 'already-exists');
    await catalog.saveApp(deps, billingStaff, input({ id: 'storage-50', isNew: true, name: 'Extra storage 50 GB', unit: 'storage_10gb', featureKeys: [], requires: [], storageGBPerUnit: 50, priceMinor: 39_900, costMinor: 10_000, sortOrder: 121 }));
    expect((await db.doc(paths.app('storage-50')).get()).data()).toMatchObject({ limitBoosts: { storageGB: 50 } });
  });

  it('adds the starting catalog only where apps are missing', async () => {
    await db.doc(paths.app('touch')).delete();
    await catalog.saveApp(deps, superadmin, input());
    expect(await catalog.seedAppCatalog(deps, superadmin)).toEqual({ added: 1 });
    expect((await db.doc(paths.app('weather')).get()).data()).toMatchObject({ priceMinor: 7_900 }); // kept
    expect(await catalog.seedAppCatalog(deps, superadmin)).toEqual({ added: 0 });
  });
});
