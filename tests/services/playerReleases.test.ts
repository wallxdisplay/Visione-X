import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type DeviceStateResponse, type PlayerReleaseDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as releases from '../../functions/src/players/releases';
import * as screens from '../../functions/src/screens/screens';
import { fakeApk } from '../fixtures/apk';
import { bucket, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const ops = user('ops1', { platformRole: 'ops' });

async function newOrg(owner: ReturnType<typeof user>, name: string): Promise<string> {
  const r = await submitOrgSignup(deps, owner, {
    orgName: name, contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  return r.orgId;
}

/** A paired, authorized player in `orgId`; returns a function reading its /devices/me. */
async function player(owner: ReturnType<typeof user>, orgId: string, ip: string) {
  const reg = await handle(deps, {
    method: 'POST', path: '/api/v1/devices/register', headers: {}, ip,
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '11', sdkInt: 30, appVersion: '0.8.0', display: { width: 1920, height: 1080 } } },
  });
  const b = reg.body as { deviceId: string; deviceSecret: string; pairingCode: string };
  await screens.claimDevice(deps, owner, { orgId, pairingCode: b.pairingCode, name: 'Lobby', siteId: null, groupIds: [], orientation: 'landscape', resolution: { width: 1920, height: 1080 } });
  return async () =>
    ((await handle(deps, { method: 'GET', path: '/api/v1/devices/me', headers: { authorization: `Device ${b.deviceId}:${b.deviceSecret}` }, body: {}, ip })).body as DeviceStateResponse).update;
}

/** Reserve, upload and check an APK as the ops user. */
async function upload(apk: Buffer, notes = '') {
  const { releaseId, path } = await releases.createPlayerReleaseUpload(deps, ops, { bytes: apk.length });
  await bucket.file(path).save(apk, { contentType: 'application/vnd.android.package-archive' });
  return { releaseId, result: releases.registerPlayerRelease(deps, ops, { releaseId, notes }) };
}
const release = async (id: string) => (await db.doc(paths.playerRelease(id)).get()).data() as PlayerReleaseDoc;

beforeEach(async () => {
  await resetEmulator();
  releases.resetReleaseCache();
});

describe('player releases', () => {
  it('checks the APK and remembers the signing key of the first release', async () => {
    const { releaseId, result } = await upload(fakeApk({ versionCode: 9, versionName: '0.9.0' }), 'Faster sync');
    expect(await result).toEqual({ versionCode: 9, versionName: '0.9.0' });
    expect(await release(releaseId)).toMatchObject({ status: 'ready', versionCode: 9, rollout: 'draft', notes: 'Faster sync', minSdk: 24 });
    const signer = (await release(releaseId)).signerSha256;
    expect((await db.doc(paths.platformSettings()).get()).data()).toMatchObject({ playerSignerSha256: signer });

    // Not newer, another app, another key: refused, file deleted, reason kept.
    const older = await upload(fakeApk({ versionCode: 9 }));
    await expectCode(older.result, 'invalid-argument');
    expect(await release(older.releaseId)).toMatchObject({ status: 'failed', error: expect.stringContaining('not newer') });
    expect((await bucket.file(paths.playerApk(older.releaseId)).exists())[0]).toBe(false);
    await expectCode((await upload(fakeApk({ versionCode: 10, packageName: 'com.example.other' }))).result, 'invalid-argument');
    const otherKey = await upload(fakeApk({ versionCode: 10, cert: 'someone-else' }));
    await expectCode(otherKey.result, 'invalid-argument');
    expect((await release(otherKey.releaseId)).error).toContain('different key');
    await expectCode((await upload(Buffer.from('not an apk'))).result, 'invalid-argument');
  });

  it('offers a release to pilot organizations first, then everyone; withdrawn stops it', async () => {
    const alice = user('alice');
    const bob = user('bob');
    const pilotOrg = await newOrg(alice, 'Pilot Retail');
    const otherOrg = await newOrg(bob, 'Other Retail');
    const pilotMe = await player(alice, pilotOrg, '10.0.0.1');
    const otherMe = await player(bob, otherOrg, '10.0.0.2');

    const { releaseId, result } = await upload(fakeApk({ versionCode: 9, versionName: '0.9.0' }));
    await result;
    expect(await pilotMe()).toBeNull(); // draft

    await releases.setPlayerRollout(deps, ops, { releaseId, rollout: 'pilot', pilotOrgIds: [pilotOrg] });
    const offer = await pilotMe();
    expect(offer).toMatchObject({ versionCode: 9, versionName: '0.9.0', sha256: (await release(releaseId)).sha256, url: expect.stringContaining('player.apk') });
    expect(await otherMe()).toBeNull();
    expect((await release(releaseId)).publishedAt).not.toBeNull();

    await releases.setPlayerRollout(deps, ops, { releaseId, rollout: 'all', pilotOrgIds: [] });
    expect((await otherMe())?.versionCode).toBe(9);
    await releases.setPlayerRollout(deps, ops, { releaseId, rollout: 'withdrawn', pilotOrgIds: [] });
    expect(await pilotMe()).toBeNull();
  });

  it('needs player.release (superadmin, ops)', async () => {
    const support = user('sup', { platformRole: 'support' });
    await expectCode(releases.createPlayerReleaseUpload(deps, support, { bytes: 100 }), 'permission-denied');
    await expectCode(releases.createPlayerReleaseUpload(deps, user('alice'), { bytes: 100 }), 'permission-denied');
    await releases.createPlayerReleaseUpload(deps, superadmin, { bytes: 100 });
  });
});
