import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paths, type MediaDoc } from '@visione-x/shared';
import { layoutFromTemplate, BUILT_IN_TEMPLATES } from '@visione-x/layout-spec';
import * as content from '../../functions/src/content/media';
import * as layouts from '../../functions/src/content/layouts';
import * as schedules from '../../functions/src/content/schedules';
import { verifyAuditChain } from '../../functions/src/lib/audit';
import { processUploadedMedia } from '../../functions/src/media/process';
import * as members from '../../functions/src/members/members';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { upsertSite } from '../../functions/src/orgs/settings';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { bucket, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const run = promisify(execFile);
const alice = user('alice');
let orgId: string;
let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'vx-test-'));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
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
    expectedScreens: 4,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

const media = async (id: string) => (await db.doc(paths.media(orgId, id)).get()).data() as MediaDoc;
const usage = async () => Number((await db.doc(paths.orgUsage(orgId)).get()).get('storageBytes') ?? 0);

/** Reserve, upload bytes to the reserved path, and run the processor (what the trigger does). */
async function uploadAndProcess(name: string, mimeType: string, data: Buffer, declared = data.length) {
  const { mediaId, uploadPath } = await content.createMediaUpload(deps, alice, { orgId, name, mimeType, bytes: declared });
  await bucket.file(uploadPath).save(data, { contentType: mimeType });
  const result = await processUploadedMedia(deps, { name: uploadPath, size: data.length, contentType: mimeType });
  return { mediaId, result };
}

describe('media uploads', () => {
  it('rejects unsupported types and oversize files; viewers cannot upload', async () => {
    await expectCode(
      content.createMediaUpload(deps, alice, { orgId, name: 'a.exe', mimeType: 'application/x-msdownload', bytes: 10 }),
      'invalid-argument',
    );
    await expectCode(
      content.createMediaUpload(deps, alice, { orgId, name: 'big.mp4', mimeType: 'video/mp4', bytes: 600 * 1024 * 1024 }),
      'invalid-argument',
    );
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'bob@example.com', role: 'viewer' });
    await members.acceptInvite(deps, user('bob'), { token });
    await expectCode(
      content.createMediaUpload(deps, user('bob'), { orgId, name: 'x.png', mimeType: 'image/png', bytes: 10 }),
      'permission-denied',
    );
  });

  it('enforces the plan storage quota (trial: 2 GB)', async () => {
    await db.doc(paths.orgUsage(orgId)).set({ storageBytes: 2 * 1024 ** 3 - 1000 }, { merge: true });
    await expectCode(
      content.createMediaUpload(deps, alice, { orgId, name: 'x.png', mimeType: 'image/png', bytes: 5000 }),
      'resource-exhausted',
    );
  });

  it('processes an image: metadata, thumbnail, checksum, quota', async () => {
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#4F46E5' } }).png().toBuffer();
    const { mediaId, result } = await uploadAndProcess('banner.png', 'image/png', png);
    expect(result).toBe('processed');
    const m = await media(mediaId);
    expect(m).toMatchObject({ status: 'ready', width: 1200, height: 800, type: 'image' });
    expect(m.display?.path).toBe(m.originalPath); // passthrough
    expect(m.display?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(m.thumb?.path).toMatch(/thumb\.jpg$/);
    const [thumbExists] = await bucket.file(m.thumb!.path).exists();
    expect(thumbExists).toBe(true);
    expect(await usage()).toBe(m.storedBytes);
  });

  it('transcodes a non-H.264 video to a screen-safe MP4 with a poster', async () => {
    const src = join(work, 'clip.mkv');
    await run(ffmpeg.path, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '2', '-c:v', 'mpeg4', src]);
    const { mediaId, result } = await uploadAndProcess('clip.mkv', 'video/x-matroska', await readFile(src));
    const m = await media(mediaId);
    expect(result, m.error).toBe('processed');
    expect(m.display).toMatchObject({ mimeType: 'video/mp4', width: 640, height: 360 });
    expect(m.display?.path).toMatch(/display\.mp4$/);
    expect(m.durationSec).toBeCloseTo(2, 0);
    expect(m.thumb?.path).toMatch(/thumb\.jpg$/);
  }, 60_000);

  it('marks fake files as failed, deletes them and releases the quota', async () => {
    const { mediaId, result } = await uploadAndProcess('fake.png', 'image/png', Buffer.from('not really a png'));
    expect(result).toBe('failed');
    const m = await media(mediaId);
    expect(m.status).toBe('failed');
    expect(m.error).toMatch(/could not be read/);
    expect((await bucket.file(m.originalPath).exists())[0]).toBe(false);
    expect(await usage()).toBe(0);
  });

  it('rejects a type mismatch between reservation and upload', async () => {
    const { mediaId, uploadPath } = await content.createMediaUpload(deps, alice, { orgId, name: 'x.png', mimeType: 'image/png', bytes: 100 });
    await bucket.file(uploadPath).save(Buffer.alloc(50), { contentType: 'image/jpeg' });
    expect(await processUploadedMedia(deps, { name: uploadPath, size: 50, contentType: 'image/jpeg' })).toBe('failed');
    expect((await media(mediaId)).status).toBe('failed');
  });

  it('ignores retries and unrelated paths', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    const { mediaId } = await uploadAndProcess('a.png', 'image/png', png);
    const m = await media(mediaId);
    expect(await processUploadedMedia(deps, { name: m.originalPath, size: png.length, contentType: 'image/png' })).toBe('ignored');
    expect(await processUploadedMedia(deps, { name: 'something/else', size: 1, contentType: 'image/png' })).toBe('ignored');
  });
});

describe('layouts, playlists, schedules', () => {
  async function readyImage() {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#000' } }).png().toBuffer();
    return (await uploadAndProcess('img.png', 'image/png', png)).mediaId;
  }
  const template = BUILT_IN_TEMPLATES.find((t) => t.id === 'l-bar')!;

  it('saves a multi-zone layout and blocks deleting media it uses', async () => {
    const mediaId = await readyImage();
    const body = layoutFromTemplate(template, 'Lobby', { width: 1920, height: 1080 });
    body.zones[0]!.content = { kind: 'media', mediaId, fit: 'cover' };
    body.zones[2]!.content = { kind: 'widget', widget: { type: 'text', text: 'स्वागत', style: {} } };
    const { layoutId } = await layouts.saveLayout(deps, alice, { orgId, layout: body });

    const saved = (await db.doc(paths.layout(orgId, layoutId)).get()).data()!;
    expect(saved.mediaIds).toEqual([mediaId]);
    await expectCode(content.deleteMedia(deps, alice, { orgId, mediaId }), 'failed-precondition');

    await layouts.deleteLayout(deps, alice, { orgId, layoutId });
    await content.deleteMedia(deps, alice, { orgId, mediaId });
    expect(await usage()).toBe(0);
  });

  it('rejects unreleased widgets and missing media', async () => {
    const body = layoutFromTemplate(BUILT_IN_TEMPLATES[0]!, 'X', { width: 1920, height: 1080 });
    body.zones[0]!.content = { kind: 'widget', widget: { type: 'weather', dataSourceId: 'd', style: {} } };
    await expectCode(layouts.saveLayout(deps, alice, { orgId, layout: body }), 'invalid-argument');
    body.zones[0]!.content = { kind: 'media', mediaId: 'nope', fit: 'cover' };
    await expectCode(layouts.saveLayout(deps, alice, { orgId, layout: body }), 'invalid-argument');
  });

  it('prevents layout ↔ playlist nesting cycles', async () => {
    const mediaId = await readyImage();
    const { layoutId } = await layouts.saveLayout(deps, alice, {
      orgId,
      layout: layoutFromTemplate(BUILT_IN_TEMPLATES[0]!, 'Full', { width: 1920, height: 1080 }),
    });
    const { playlistId: withLayout } = await layouts.savePlaylist(deps, alice, {
      orgId,
      name: 'Has layout',
      items: [{ id: 'i1', content: { kind: 'layout', layoutId }, durationSec: 10, transition: 'none' }],
    });
    // A playlist that contains layouts cannot be placed in a zone…
    const zoned = layoutFromTemplate(BUILT_IN_TEMPLATES[0]!, 'Zoned', { width: 1920, height: 1080 });
    zoned.zones[0]!.content = { kind: 'playlist', playlistId: withLayout };
    await expectCode(layouts.saveLayout(deps, alice, { orgId, layout: zoned }), 'invalid-argument');

    // …and a playlist already in a zone cannot gain layouts.
    const { playlistId: simple } = await layouts.savePlaylist(deps, alice, {
      orgId,
      name: 'Simple',
      items: [{ id: 'i1', content: { kind: 'media', mediaId }, durationSec: 8, transition: 'fade' }],
    });
    zoned.zones[0]!.content = { kind: 'playlist', playlistId: simple };
    await layouts.saveLayout(deps, alice, { orgId, layout: zoned });
    await expectCode(
      layouts.savePlaylist(deps, alice, {
        orgId,
        playlistId: simple,
        name: 'Simple',
        items: [{ id: 'i1', content: { kind: 'layout', layoutId }, durationSec: 5, transition: 'none' }],
      }),
      'failed-precondition',
    );
    await expectCode(layouts.deleteLayout(deps, alice, { orgId, layoutId }), 'failed-precondition');
  });

  it('schedules: validate targets, block deleting used playlists and groups, audit everything', async () => {
    const { siteId } = await upsertSite(deps, alice, { orgId, name: 'HQ', timezone: 'Asia/Kolkata' });
    const { groupId } = await schedules.upsertScreenGroup(deps, alice, { orgId, name: 'Lobby walls', siteId });
    const { playlistId } = await layouts.savePlaylist(deps, alice, {
      orgId,
      name: 'Morning',
      items: [{ id: 'w', content: { kind: 'widget', widget: { type: 'clock', format: 'time', timezone: 'Asia/Kolkata', seconds: false, style: {} } }, durationSec: 30, transition: 'none' }],
    });
    const base = {
      orgId,
      name: 'Weekday mornings',
      playlistId,
      priority: 10,
      timezone: 'Asia/Kolkata',
      startDate: null,
      endDate: null,
      daysOfWeek: [1, 2, 3, 4, 5],
      windowStart: '06:00',
      windowEnd: '11:00',
      enabled: true,
    };
    await expectCode(
      schedules.saveSchedule(deps, alice, { ...base, target: { kind: 'groups', ids: ['missing'] } }),
      'invalid-argument',
    );
    await schedules.saveSchedule(deps, alice, { ...base, target: { kind: 'groups', ids: [groupId] } });

    await expectCode(layouts.deletePlaylist(deps, alice, { orgId, playlistId }), 'failed-precondition');
    await expectCode(schedules.deleteScreenGroup(deps, alice, { orgId, groupId }), 'failed-precondition');

    const result = await verifyAuditChain(db, orgId);
    expect(result.ok).toBe(true);
  });
});
