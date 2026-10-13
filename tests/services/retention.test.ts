import { createHash } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { paths } from '@wallx-play/shared';
import * as media from '../../functions/src/content/media';
import * as members from '../../functions/src/members/members';
import { archivePath, exportAuditLogs } from '../../functions/src/ops/auditExport';
import { runRetention } from '../../functions/src/ops/retention';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { advance, bucket, db, deps, resetEmulator, superadmin, user } from './helpers';

const DAY = 86_400_000;
const alice = user('alice');
let orgId: string;

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Chai Point', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

const exists = async (path: string) => (await db.doc(path).get()).exists;
const usage = async () => Number((await db.doc(paths.orgUsage(orgId)).get()).data()?.storageBytes ?? 0);

describe('retention', () => {
  it('removes old operational records and keeps recent ones', async () => {
    const t0 = deps.now();
    const old = await members.inviteMember(deps, alice, { orgId, email: 'old@example.com', role: 'viewer', siteScope: [] });
    const cmd = (id: string, createdAt: number, screenshotPath: string | null) =>
      db.doc(paths.command(orgId, 's1', id)).set({ id, type: 'screenshot', status: 'done', createdAt, deliveredAt: null, completedAt: null, result: null, screenshotPath });
    await bucket.file(`orgs/${orgId}/screenshots/s1/c-old.jpg`).save(Buffer.from('jpg'));
    await cmd('c-old', t0, `orgs/${orgId}/screenshots/s1/c-old.jpg`);
    await db.doc(`orgs/${orgId}/notifications/n-old`).set({ id: 'n-old', type: 'x', params: {}, link: null, createdAt: t0, readBy: [] });
    await db.doc('pairingCodes/OLDOLD').set({ deviceId: 'd', expiresAt: t0 });
    await db.doc(paths.playerRelease('r-failed')).set({ id: 'r-failed', status: 'failed', createdAt: t0 });
    await bucket.file(paths.playerApk('r-failed')).save(Buffer.from('apk'));

    advance(91 * DAY);
    const now = deps.now();
    const recent = await members.inviteMember(deps, alice, { orgId, email: 'new@example.com', role: 'viewer', siteScope: [] });
    await cmd('c-new', now, null);
    await db.doc(`orgs/${orgId}/notifications/n-new`).set({ id: 'n-new', type: 'x', params: {}, link: null, createdAt: now, readBy: [] });
    await db.doc('pairingCodes/NEWNEW').set({ deviceId: 'd', expiresAt: now + DAY });

    expect(await runRetention(deps)).toMatchObject({ pairingCodes: 1, invites: 1, commands: 1, screenshots: 1, notifications: 1, playerUploads: 1 });
    expect(await exists(paths.invite(orgId, old.inviteId))).toBe(false);
    expect(await exists(paths.invite(orgId, recent.inviteId))).toBe(true);
    expect(await exists(paths.command(orgId, 's1', 'c-new'))).toBe(true);
    expect((await bucket.file(`orgs/${orgId}/screenshots/s1/c-old.jpg`).exists())[0]).toBe(false);
    expect(await exists(`orgs/${orgId}/notifications/n-new`)).toBe(true);
    expect(await exists('pairingCodes/NEWNEW')).toBe(true);
    expect((await bucket.file(paths.playerApk('r-failed')).exists())[0]).toBe(false);
    // Nothing left to do on the next run.
    expect(await runRetention(deps)).toMatchObject({ pairingCodes: 0, invites: 0, commands: 0, notifications: 0 });
  });

  it('gives back the storage of uploads that never finished', async () => {
    const before = await usage();
    const { mediaId, uploadPath } = await media.createMediaUpload(deps, alice, { orgId, name: 'half.mp4', mimeType: 'video/mp4', bytes: 5_000_000 });
    await bucket.file(uploadPath).save(Buffer.from('partial'));
    expect(await usage()).toBe(before + 5_000_000);

    expect((await runRetention(deps)).abandonedUploads).toBe(0); // still within a day
    advance(DAY + 60_000);
    expect((await runRetention(deps)).abandonedUploads).toBe(1);
    expect(await exists(paths.media(orgId, mediaId))).toBe(false);
    expect(await usage()).toBe(before);
    expect((await bucket.file(uploadPath).exists())[0]).toBe(false);
    const audit = await db.collection(paths.auditLogs()).where('chainId', '==', orgId).where('action', '==', 'media.upload.abandoned').get();
    expect(audit.docs[0]?.data()).toMatchObject({ actorType: 'system', actorId: 'retention' });
  });
});

describe('audit export', () => {
  const archive = getStorage().bucket('demo-wallx-play-audit-archive');

  it('writes each finished UTC day once, with a verifiable summary', async () => {
    const day1 = new Date(deps.now()).toISOString().slice(0, 10);
    advance(2 * DAY);
    const run = await exportAuditLogs(deps, archive);
    expect(run.days).toHaveLength(2);
    expect(run.days[0]).toBe(day1);

    const [ndjson] = await archive.file(`${archivePath(day1)}.ndjson`).download();
    const summary = JSON.parse((await archive.file(`${archivePath(day1)}.summary.json`).download())[0].toString());
    const lines = ndjson.toString().trim().split('\n').map((l) => JSON.parse(l));
    expect(summary.entries).toBe(lines.length);
    expect(summary.entries).toBeGreaterThan(0);
    expect(summary.sha256).toBe(createHash('sha256').update(ndjson).digest('hex'));
    const chain = lines.filter((l) => l.chainId === orgId);
    expect(chain.map((l) => l.seq)).toEqual([...chain.map((l) => l.seq)].sort((x, y) => x - y)); // in chain order
    expect(summary.chains[orgId].lastHash).toBe(chain.at(-1).hash);

    // Already exported days are skipped; today is never exported early.
    expect((await exportAuditLogs(deps, archive)).days).toEqual([]);
    // Lost progress: re-exporting finds the files already there and does not overwrite them.
    await db.doc('platform/auditExport').delete();
    expect((await exportAuditLogs(deps, archive)).days).toHaveLength(2);
    expect((await archive.file(`${archivePath(day1)}.ndjson`).download())[0].equals(ndjson)).toBe(true);
  });
});
