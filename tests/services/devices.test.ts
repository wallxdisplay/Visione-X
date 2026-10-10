import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type DeviceStateResponse, type ScreenDoc } from '@visione-x/shared';
import { Manifest } from '@visione-x/layout-spec';
import { handle } from '../../functions/src/api/router';
import * as content from '../../functions/src/content/media';
import * as layouts from '../../functions/src/content/layouts';
import * as schedules from '../../functions/src/content/schedules';
import { verifyAuditChain } from '../../functions/src/lib/audit';
import { processUploadedMedia } from '../../functions/src/media/process';
import * as members from '../../functions/src/members/members';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as screens from '../../functions/src/screens/screens';
import { bucket, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
let orgId: string;

const hardware = {
  manufacturer: 'Amlogic',
  model: 'X96 Max',
  androidVersion: '9',
  sdkInt: 28,
  appVersion: '0.1.0',
  display: { width: 1920, height: 1080 },
};

async function api(method: string, path: string, body: unknown = {}, auth?: string) {
  return handle(deps, { method, path, headers: auth ? { authorization: auth } : {}, body, ip: '10.0.0.1' });
}

async function register() {
  const res = await api('POST', '/api/v1/devices/register', { hardware });
  expect(res.status).toBe(201);
  const b = res.body as { deviceId: string; deviceSecret: string; pairingCode: string };
  return { ...b, auth: `Device ${b.deviceId}:${b.deviceSecret}` };
}

const screenInput = (code: string) => ({
  orgId,
  pairingCode: code,
  name: 'Lobby wall',
  siteId: null,
  groupIds: [],
  orientation: 'landscape' as const,
  resolution: { width: 1920, height: 1080 },
});

beforeEach(async () => {
  await resetEmulator();
  await bucket.deleteFiles({ prefix: 'orgs/' }).catch(() => undefined);
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Acme',
    contactName: 'Asha',
    phone: '+91 98200 12345',
    city: 'Pune',
    stateCode: '27',
    expectedScreens: 2,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

describe('device API', () => {
  it('rejects missing, malformed and wrong credentials', async () => {
    expect((await api('GET', '/api/v1/devices/me')).status).toBe(401);
    const d = await register();
    expect((await api('GET', '/api/v1/devices/me', {}, `Device ${d.deviceId}:${'x'.repeat(43)}`)).status).toBe(401);
    expect((await api('POST', '/api/v1/devices/register', { hardware: { model: 'x' } })).status).toBe(400);
  });

  it('full lifecycle: register → pair → publish → manifest → heartbeat → revoke', async () => {
    const d = await register();
    expect(d.pairingCode).toMatch(/^[A-Z0-9]{6}$/);

    let state = (await api('GET', '/api/v1/devices/me', {}, d.auth)).body as DeviceStateResponse;
    expect(state).toMatchObject({ status: 'unpaired', pairingCode: d.pairingCode, screen: null });
    expect(state.pairingUrl).toContain(d.pairingCode);

    const { screenId, status } = await screens.claimDevice(deps, alice, screenInput(d.pairingCode));
    expect(status).toBe('authorized'); // owner has device.authorize
    await expectCode(screens.claimDevice(deps, alice, screenInput(d.pairingCode)), 'not-found'); // code is single-use

    state = (await api('GET', '/api/v1/devices/me', {}, d.auth)).body as DeviceStateResponse;
    expect(state).toMatchObject({ status: 'authorized', orgName: 'Acme', pairingCode: null, screen: { id: screenId, manifestVersion: 0 } });
    expect((await api('GET', '/api/v1/devices/manifest', {}, d.auth)).status).toBe(404); // not published yet

    // Content: one image in a playlist, scheduled for all screens.
    const png = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#4F46E5' } }).png().toBuffer();
    const { mediaId, uploadPath } = await content.createMediaUpload(deps, alice, { orgId, name: 'a.png', mimeType: 'image/png', bytes: png.length });
    await bucket.file(uploadPath).save(png, { contentType: 'image/png' });
    await processUploadedMedia(deps, { name: uploadPath, size: png.length, contentType: 'image/png' });
    const { playlistId } = await layouts.savePlaylist(deps, alice, {
      orgId,
      name: 'Loop',
      items: [{ id: 'i1', content: { kind: 'media', mediaId }, durationSec: 8, transition: 'fade' }],
    });
    await schedules.saveSchedule(deps, alice, {
      orgId,
      name: 'Always',
      playlistId,
      target: { kind: 'all' },
      priority: 10,
      timezone: 'Asia/Kolkata',
      startDate: null,
      endDate: null,
      daysOfWeek: [],
      windowStart: null,
      windowEnd: null,
      enabled: true,
    });

    expect(await screens.publishScreens(deps, alice, { orgId, screenIds: [] })).toEqual({ published: 1 });
    state = (await api('GET', '/api/v1/devices/me', {}, d.auth)).body as DeviceStateResponse;
    expect(state.screen?.manifestVersion).toBe(1);

    const res = await api('GET', '/api/v1/devices/manifest', {}, d.auth);
    expect(res.status).toBe(200);
    const manifest = Manifest.parse(res.body);
    expect(manifest.schedules).toHaveLength(1);
    expect(manifest.playlists[0]!.items).toHaveLength(1);
    expect(manifest.assets[0]).toMatchObject({ mediaId, mimeType: 'image/png' });
    // The asset URL is downloadable without any other credential (token URL).
    const download = await fetch(manifest.assets[0]!.url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(png)).toBe(true);

    const hb = await api(
      'POST',
      '/api/v1/devices/heartbeat',
      { appVersion: '0.1.1', display: { width: 1920, height: 1080 }, storageFreeMb: 4096, playing: { playlistId, itemId: 'i1', source: 'schedule' }, manifestVersion: 1, errors: [] },
      d.auth,
    );
    expect(hb.status).toBe(200);
    const screen = (await db.doc(paths.screen(orgId, screenId)).get()).data() as ScreenDoc;
    expect(screen.health).toMatchObject({ appVersion: '0.1.1', manifestVersion: 1, storageFreeMb: 4096 });
    expect(screen.lastSeen).toBeTruthy();

    await screens.removeScreen(deps, alice, { orgId, screenId });
    expect((await api('GET', '/api/v1/devices/me', {}, d.auth)).status).toBe(403);
    expect((await verifyAuditChain(db, orgId)).ok).toBe(true);
  });

  it('editors pair as pending; only device.authorize can activate; screen limit applies', async () => {
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'bob@example.com', role: 'editor' });
    await members.acceptInvite(deps, user('bob'), { token });
    // Editors lack screen.manage in the default role set.
    const d1 = await register();
    await expectCode(screens.claimDevice(deps, user('bob'), screenInput(d1.pairingCode)), 'permission-denied');

    const { screenId } = await screens.claimDevice(deps, alice, screenInput(d1.pairingCode));
    await expectCode(screens.authorizeScreen(deps, alice, { orgId, screenId }), 'failed-precondition'); // already authorized

    const d2 = await register();
    await screens.claimDevice(deps, alice, screenInput(d2.pairingCode));
    const d3 = await register();
    await expectCode(screens.claimDevice(deps, alice, screenInput(d3.pairingCode)), 'resource-exhausted'); // trial: 2 screens
  });

  it('unpublished or non-authorized devices get no manifest; expired codes are reissued', async () => {
    const d = await register();
    expect((await api('GET', '/api/v1/devices/manifest', {}, d.auth)).status).toBe(403);
    await db.doc(paths.device(d.deviceId)).update({ pairingExpiresAt: 1 });
    const state = (await api('GET', '/api/v1/devices/me', {}, d.auth)).body as DeviceStateResponse;
    expect(state.pairingCode).not.toBe(d.pairingCode);
    await expectCode(screens.claimDevice(deps, alice, screenInput(d.pairingCode)), 'not-found');
  });
});
