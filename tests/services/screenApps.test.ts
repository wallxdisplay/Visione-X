import { beforeEach, describe, expect, it } from 'vitest';
import { Manifest } from '@wallx-play/layout-spec';
import { paths, type ScreenDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as billing from '../../functions/src/billing/billing';
import * as layouts from '../../functions/src/content/layouts';
import * as integrations from '../../functions/src/integrations/dataSources';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { setAppScreens } from '../../functions/src/screens/screenApps';
import * as screens from '../../functions/src/screens/screens';
import { saveSyncGroup } from '../../functions/src/screens/syncGroups';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
const billingStaff = user('bill', { platformRole: 'billing' });
let orgId: string;
const ids: Record<string, string> = {};

const screen = async (name: string) => (await db.doc(paths.screen(orgId, ids[name]!)).get()).data() as ScreenDoc;
const manifest = async (name: string) => Manifest.parse((await db.doc(paths.screenManifest(orgId, ids[name]!)).get()).data());
const firstWidget = (m: Manifest) => (m.playlists[0]!.items[0]!.content as { widget: { type: string; text?: string } }).widget;
const buy = (apps: Array<{ appId: string; quantity: number }>) =>
  billing.updateSubscription(deps, billingStaff, { orgId, planId: 'starter', interval: 'monthly', quantity: 3, customPriceMinor: null, discountBps: 0, apps, repriceApps: false, reason: 'Customer chose apps' });
/** Sync is not released yet: entitlements leave it out until staff release it. */
const releaseSync = async () => {
  const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
  await db.doc(paths.orgEntitlements(orgId)).update({ features: [...new Set([...(ent.features as string[]), 'screen.multiSync'])] });
};
const pay = () => billing.recordPayment(deps, billingStaff, { orgId, amountMinor: 1, method: 'upi', reference: 'UTR-1', paidAt: deps.now(), periods: 1 });

async function pair(name: string) {
  const reg = await handle(deps, {
    method: 'POST', path: '/api/v1/devices/register', headers: {}, ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '12', sdkInt: 31, appVersion: '0.19.0', display: { width: 1920, height: 1080 } } },
  });
  ids[name] = (
    await screens.claimDevice(deps, alice, {
      orgId, pairingCode: (reg.body as { pairingCode: string }).pairingCode, name, siteId: null, groupIds: [], orientation: 'landscape', resolution: { width: 1920, height: 1080 },
    })
  ).screenId;
}

const show = (name: string, playlistId: string) =>
  screens.updateScreen(deps, alice, {
    orgId, screenId: ids[name]!, name, siteId: null, groupIds: [], orientation: 'landscape', resolution: { width: 1920, height: 1080 }, rotation: 0, defaultPlaylistId: playlistId,
  });

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Acme', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 3, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
  await db.doc(paths.orgEntitlements(orgId)).update({ 'limits.screens': 10 });
  for (const n of ['Alpha', 'Bravo', 'Charlie']) await pair(n);
});

describe('apps per screen', () => {
  it('weather plays only on the screens holding the app; the others show a notice', async () => {
    // In the trial every app is on every screen.
    expect((await screen('Charlie')).blockedFeatures ?? []).toEqual([]);
    const { dataSourceId } = await integrations.saveDataSource(deps, alice, { orgId, name: 'Pune', type: 'weather', config: { placeName: 'Pune', latitude: 18.52, longitude: 73.86 } });
    const { playlistId } = await layouts.savePlaylist(deps, alice, {
      orgId, name: 'Lobby',
      items: [{ id: 'w', content: { kind: 'widget', widget: { type: 'weather', dataSourceId, layout: 'current', style: {} } }, durationSec: 10, transition: 'none' }],
    });
    for (const n of ['Alpha', 'Bravo', 'Charlie']) await show(n, playlistId);

    // Weather bought for 2 of 3 screens; paying ends the trial. Seats go by name.
    await buy([{ appId: 'weather', quantity: 2 }]);
    await pay();
    expect((await screen('Alpha')).apps).toEqual(['weather']);
    expect((await screen('Bravo')).apps).toEqual(['weather']);
    expect(await screen('Charlie')).toMatchObject({ apps: [], blockedFeatures: expect.arrayContaining(['widget.weather', 'interactive.touch']) });

    const r = await screens.publishScreens(deps, alice, { orgId, screenIds: [] });
    expect(r.missingApps).toEqual([{ screenId: ids.Charlie, name: 'Charlie', features: ['widget.weather'] }]);
    expect(firstWidget(await manifest('Alpha')).type).toBe('weather');
    expect(firstWidget(await manifest('Charlie'))).toMatchObject({ type: 'text', text: 'Weather & air quality is not enabled on this screen' });

    // Moving the app: Charlie gains it, Alpha loses it; both get new content at once.
    await expectCode(setAppScreens(deps, alice, { orgId, appId: 'weather', screenIds: [ids.Alpha!, ids.Bravo!, ids.Charlie!] }), 'failed-precondition');
    await expectCode(setAppScreens(deps, alice, { orgId, appId: 'screen', screenIds: [] }), 'invalid-argument');
    expect(await setAppScreens(deps, alice, { orgId, appId: 'weather', screenIds: [ids.Bravo!, ids.Charlie!] })).toEqual({ republished: 2 });
    expect(firstWidget(await manifest('Alpha')).type).toBe('text');
    expect(firstWidget(await manifest('Charlie')).type).toBe('weather');

    // Removing a screen frees its seat for the next one.
    await screens.removeScreen(deps, alice, { orgId, screenId: ids.Bravo! });
    expect((await screen('Alpha')).apps).toEqual(['weather']);
    expect(firstWidget(await manifest('Alpha')).type).toBe('weather');
  });

  it('a sync group needs the Sync app on each of its screens', async () => {
    await buy([{ appId: 'sync', quantity: 1 }]);
    await pay();
    await releaseSync();
    const { playlistId } = await layouts.savePlaylist(deps, alice, {
      orgId, name: 'Loop', items: [{ id: 'i', content: { kind: 'widget', widget: { type: 'text', text: 'Hi', style: {} } }, durationSec: 5, transition: 'none' }],
    });
    await expectCode(
      saveSyncGroup(deps, alice, { orgId, name: 'Pair', mode: 'mirror', playlistId, rows: 1, cols: 1, members: [{ screenId: ids.Alpha!, row: 0, col: 0 }, { screenId: ids.Bravo!, row: 0, col: 0 }], enabled: true }),
      'failed-precondition',
    );
    await buy([{ appId: 'sync', quantity: 2 }]);
    await releaseSync();
    await saveSyncGroup(deps, alice, { orgId, name: 'Pair', mode: 'mirror', playlistId, rows: 1, cols: 1, members: [{ screenId: ids.Alpha!, row: 0, col: 0 }, { screenId: ids.Bravo!, row: 0, col: 0 }], enabled: true });
    expect((await manifest('Alpha')).sync).not.toBeNull();
  });

  it('plan pricing keeps every feature on every screen', async () => {
    await billing.updateSubscription(deps, billingStaff, { orgId, planId: 'starter', interval: 'monthly', quantity: 3, customPriceMinor: null, discountBps: 0, pricing: 'plan', repriceApps: false, reason: 'Plan customer' });
    await pay();
    expect((await screen('Charlie')).blockedFeatures ?? []).toEqual([]);
  });
});
