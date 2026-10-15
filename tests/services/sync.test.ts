import { beforeEach, describe, expect, it } from 'vitest';
import { Manifest } from '@wallx-play/layout-spec';
import { SaveSyncGroupInput, paths, type ScreenDoc, type SyncGroupDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as layouts from '../../functions/src/content/layouts';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as screens from '../../functions/src/screens/screens';
import { deleteSyncGroup, saveSyncGroup } from '../../functions/src/screens/syncGroups';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
let orgId: string;
let playlistId: string;
const ids: string[] = [];

async function pair(name: string) {
  const reg = await handle(deps, {
    method: 'POST',
    path: '/api/v1/devices/register',
    headers: {},
    ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '11', sdkInt: 30, appVersion: '0.16.0', display: { width: 1920, height: 1080 } } },
  });
  const { screenId } = await screens.claimDevice(deps, alice, {
    orgId,
    pairingCode: (reg.body as { pairingCode: string }).pairingCode,
    name,
    siteId: null,
    groupIds: [],
    orientation: 'landscape',
    resolution: { width: 1920, height: 1080 },
  });
  return screenId;
}

const manifestOf = async (screenId: string) => Manifest.parse((await db.doc(paths.screenManifest(orgId, screenId)).get()).data());
const screenOf = async (screenId: string) => (await db.doc(paths.screen(orgId, screenId)).get()).data() as ScreenDoc;
const enableSync = async (on = true) => {
  const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
  const features = (ent.features as string[]).filter((f) => f !== 'screen.multiSync');
  await db.doc(paths.orgEntitlements(orgId)).update({ features: on ? [...features, 'screen.multiSync'] : features });
};

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Acme',
    contactName: 'Asha',
    phone: '+91 98200 12345',
    city: 'Pune',
    stateCode: '27',
    expectedScreens: 4,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
  ({ playlistId } = await layouts.savePlaylist(deps, alice, {
    orgId,
    name: 'Window',
    items: [
      { id: 'a', content: { kind: 'widget', widget: { type: 'text', text: 'Sale', style: {} } }, durationSec: 8, transition: 'none' },
      { id: 'b', content: { kind: 'widget', widget: { type: 'text', text: 'New in', style: {} } }, durationSec: 12, transition: 'none' },
    ],
  }));
  await db.doc(paths.orgEntitlements(orgId)).update({ 'limits.screens': 10 }); // trial allows 2
  ids.length = 0;
  for (const n of ['Left', 'Right', 'Third']) ids.push(await pair(n));
});

describe('sync groups', () => {
  it('need the plan feature; a mirror group plays its playlist on a shared timeline', async () => {
    const input = { orgId, name: 'Shop window', mode: 'mirror' as const, playlistId, members: [{ screenId: ids[0]!, row: 0, col: 0 }, { screenId: ids[1]!, row: 0, col: 0 }], rows: 1, cols: 1, enabled: true };
    await expectCode(saveSyncGroup(deps, alice, input), 'permission-denied');
    await enableSync();
    const { groupId, published } = await saveSyncGroup(deps, alice, input);
    expect(published).toBe(2);
    const group = (await db.doc(paths.syncGroup(orgId, groupId)).get()).data() as SyncGroupDoc;
    expect(group.anchor % 1000).toBe(0);
    for (const id of ids.slice(0, 2)) {
      expect((await screenOf(id)).syncGroupId).toBe(groupId);
      const m = await manifestOf(id);
      expect(m.sync).toEqual({ groupId, mode: 'mirror', anchor: group.anchor, tile: null });
      expect(m.defaultPlaylistId).toBe(playlistId);
      expect(m.schedules).toEqual([]);
    }
    expect((await screenOf(ids[2]!)).syncGroupId ?? null).toBeNull();
    await expectCode(saveSyncGroup(deps, user('eve'), { ...input, groupId }), 'permission-denied');
  });

  it('builds video walls, keeps a screen in one group, and publishes members together', async () => {
    await enableSync();
    const { groupId } = await saveSyncGroup(deps, alice, {
      orgId,
      name: 'Lobby wall',
      mode: 'wall',
      playlistId,
      rows: 1,
      cols: 2,
      members: [
        { screenId: ids[0]!, row: 0, col: 0 },
        { screenId: ids[1]!, row: 0, col: 1 },
      ],
      enabled: true,
    });
    expect((await manifestOf(ids[1]!)).sync?.tile).toEqual({ rows: 1, cols: 2, row: 0, col: 1 });
    await expectCode(
      saveSyncGroup(deps, alice, { orgId, name: 'Other', mode: 'mirror', playlistId, rows: 1, cols: 1, members: [{ screenId: ids[1]!, row: 0, col: 0 }, { screenId: ids[2]!, row: 0, col: 0 }], enabled: true }),
      'failed-precondition',
    );

    // Publishing one member republishes the whole group (one version of the content at a time).
    const before = await Promise.all(ids.slice(0, 2).map(async (id) => (await screenOf(id)).manifestVersion));
    await screens.publishScreens(deps, alice, { orgId, screenIds: [ids[0]!] });
    const after = await Promise.all(ids.slice(0, 2).map(async (id) => (await screenOf(id)).manifestVersion));
    expect(after).toEqual(before.map((v) => v + 1));

    // Removing a member hands it back to its own schedule; deleting clears everyone.
    await saveSyncGroup(deps, alice, { orgId, groupId, name: 'Lobby', mode: 'mirror', playlistId, rows: 1, cols: 1, members: [{ screenId: ids[0]!, row: 0, col: 0 }, { screenId: ids[2]!, row: 0, col: 0 }], enabled: true });
    expect((await screenOf(ids[1]!)).syncGroupId).toBeNull();
    expect((await manifestOf(ids[1]!)).sync).toBeNull();
    expect((await manifestOf(ids[2]!)).sync?.groupId).toBe(groupId);
    await deleteSyncGroup(deps, alice, { orgId, groupId });
    for (const id of [ids[0]!, ids[2]!]) {
      expect((await screenOf(id)).syncGroupId).toBeNull();
      expect((await manifestOf(id)).sync).toBeNull();
    }
  });

  it('validates the wall grid and serves the clock', async () => {
    const wall = { orgId, name: 'Wall', mode: 'wall', playlistId, rows: 2, cols: 2, members: [{ screenId: 'a', row: 0, col: 0 }, { screenId: 'b', row: 0, col: 1 }] };
    expect(SaveSyncGroupInput.safeParse(wall).success).toBe(false); // 2 screens for a 2×2 wall
    expect(SaveSyncGroupInput.safeParse({ ...wall, rows: 1, members: [{ screenId: 'a', row: 0, col: 0 }, { screenId: 'b', row: 0, col: 0 }] }).success).toBe(false);
    expect(SaveSyncGroupInput.safeParse({ ...wall, rows: 1 }).success).toBe(true);
    const clock = await handle(deps, { method: 'GET', path: '/api/v1/devices/time', headers: {}, body: {}, ip: '1.1.1.1' });
    expect(clock).toEqual({ status: 200, body: { serverTime: deps.now() } });
  });
});
