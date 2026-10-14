import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type PlayStatsDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as members from '../../functions/src/members/members';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { upsertSite } from '../../functions/src/orgs/settings';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { playbackReport } from '../../functions/src/reports/plays';
import * as screens from '../../functions/src/screens/screens';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
const HOUR = 3_600_000;
// The test clock starts 2026-10-01 09:00 UTC (14:30 in India).
const at = (iso: string) => Date.parse(iso);

let orgId: string;
let pune: string;
let mumbai: string;
const players: Record<string, { auth: string; screenId: string }> = {};

async function pairScreen(name: string, siteId: string) {
  const reg = await handle(deps, {
    method: 'POST',
    path: '/api/v1/devices/register',
    headers: {},
    ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '11', sdkInt: 30, appVersion: '0.13.0', display: { width: 1920, height: 1080 } } },
  });
  const b = reg.body as { deviceId: string; deviceSecret: string; pairingCode: string };
  const { screenId } = await screens.claimDevice(deps, alice, {
    orgId,
    pairingCode: b.pairingCode,
    name,
    siteId,
    groupIds: [],
    orientation: 'landscape',
    resolution: { width: 1920, height: 1080 },
  });
  return { auth: `Device ${b.deviceId}:${b.deviceSecret}`, screenId };
}

const upload = (player: { auth: string }, body: unknown) =>
  handle(deps, { method: 'POST', path: '/api/v1/devices/plays', headers: { authorization: player.auth }, body, ip: '10.0.0.9' });

const enableReports = async (on = true) => {
  const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
  const features = (ent.features as string[]).filter((f) => f !== 'report.proofOfPlay');
  await db.doc(paths.orgEntitlements(orgId)).update({ features: on ? [...features, 'report.proofOfPlay'] : features });
};

beforeEach(async () => {
  await resetEmulator();
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
  ({ siteId: pune } = await upsertSite(deps, alice, { orgId, name: 'Pune', timezone: 'Asia/Kolkata' }));
  ({ siteId: mumbai } = await upsertSite(deps, alice, { orgId, name: 'Mumbai', timezone: 'Asia/Kolkata' }));
  players.lobby = await pairScreen('Lobby', pune);
  players.cafe = await pairScreen('Cafe', mumbai);
  await db.doc(paths.media(orgId, 'm1')).set({ name: 'Diwali offer' });
});

const buckets = [
  // 30 Sep 18:00 UTC = 23:30 IST on 30 Sep.
  { hour: at('2026-09-30T18:00:00Z'), kind: 'media', id: 'm1', plays: 4, seconds: 40 },
  // 30 Sep 20:00 UTC = 01:30 IST on 1 Oct.
  { hour: at('2026-09-30T20:00:00Z'), kind: 'media', id: 'm1', plays: 6, seconds: 60 },
  { hour: at('2026-10-01T08:00:00Z'), kind: 'layout', id: 'gone', plays: 2, seconds: 600 },
];

describe('play uploads', () => {
  it('keeps nothing while the plan has no proof-of-play reports', async () => {
    const res = await upload(players.lobby!, { batchId: 'batch-0001', buckets });
    expect(res).toEqual({ status: 200, body: { ok: true, stored: false } });
    expect((await db.collection(paths.playStats(orgId)).get()).size).toBe(0);
  });

  it('folds hours into local days, counts a retried upload once and drops stale hours', async () => {
    await enableReports();
    const stale = { hour: deps.now() - 40 * 24 * HOUR - (deps.now() % HOUR), kind: 'media', id: 'm1', plays: 99, seconds: 99 };
    for (let i = 0; i < 2; i++) {
      expect((await upload(players.lobby!, { batchId: 'batch-0002', buckets: [...buckets, stale] })).body).toEqual({ ok: true, stored: true });
    }
    const day = (await db.doc(paths.playStat(orgId, '2026-10-01', players.lobby!.screenId)).get()).data() as PlayStatsDoc;
    expect(day).toMatchObject({ date: '2026-10-01', siteId: pune, plays: 8, seconds: 660 });
    expect(day.items).toEqual({ media_m1: { plays: 6, seconds: 60 }, layout_gone: { plays: 2, seconds: 600 } });
    expect(day.hours).toEqual({ '01': { plays: 6, seconds: 60 }, '13': { plays: 2, seconds: 600 } });
    const prev = (await db.doc(paths.playStat(orgId, '2026-09-30', players.lobby!.screenId)).get()).data() as PlayStatsDoc;
    expect(prev).toMatchObject({ plays: 4, hours: { '23': { plays: 4, seconds: 40 } } });
    // A later upload adds to the same day.
    await upload(players.lobby!, { batchId: 'batch-0003', buckets: [{ hour: at('2026-10-01T08:00:00Z'), kind: 'media', id: 'm1', plays: 1, seconds: 10 }] });
    const after = (await db.doc(paths.playStat(orgId, '2026-10-01', players.lobby!.screenId)).get()).data() as PlayStatsDoc;
    expect(after.items.media_m1).toEqual({ plays: 7, seconds: 70 });
    expect((await upload(players.lobby!, { batchId: 'x', buckets })).status).toBe(400);
  });
});

describe('playback report', () => {
  beforeEach(async () => {
    await enableReports();
    await upload(players.lobby!, { batchId: 'lobby-001', buckets });
    await upload(players.cafe!, { batchId: 'cafe-0001', buckets: [{ hour: at('2026-10-01T08:00:00Z'), kind: 'media', id: 'm1', plays: 3, seconds: 30 }] });
  });

  it('totals by content, screen, day and hour with current names', async () => {
    const r = await playbackReport(deps, alice, { orgId, from: '2026-09-30', to: '2026-10-01', siteId: null, screenId: null });
    expect(r.totals).toEqual({ plays: 15, seconds: 730, screens: 2, items: 2 });
    expect(r.byContent).toEqual([
      { kind: 'media', id: 'm1', name: 'Diwali offer', plays: 13, seconds: 130, screens: 2 },
      { kind: 'layout', id: 'gone', name: '', plays: 2, seconds: 600, screens: 1 },
    ]);
    expect(r.byScreen.map((s) => [s.name, s.plays])).toEqual([['Lobby', 12], ['Cafe', 3]]);
    expect(r.byDay).toEqual([{ date: '2026-09-30', plays: 4, seconds: 40 }, { date: '2026-10-01', plays: 11, seconds: 690 }]);
    expect(r.byHour[23]).toBe(4);
    expect(r.byHour[13]).toBe(5);
    expect(r.rows).toHaveLength(4);
    expect(r.rowsTruncated).toBe(false);

    const oneScreen = await playbackReport(deps, alice, { orgId, from: '2026-10-01', to: '2026-10-01', siteId: null, screenId: players.cafe!.screenId });
    expect(oneScreen.totals.plays).toBe(3);
    const oneSite = await playbackReport(deps, alice, { orgId, from: '2026-09-01', to: '2026-10-01', siteId: pune, screenId: null });
    expect(oneSite.totals.plays).toBe(12);
  });

  it('limits site-scoped members to their sites and needs the plan feature', async () => {
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'priya@example.com', role: 'viewer', siteScope: [mumbai] });
    await members.acceptInvite(deps, user('priya'), { token });
    const priya = user('priya');
    const r = await playbackReport(deps, priya, { orgId, from: '2026-09-30', to: '2026-10-01', siteId: null, screenId: null });
    expect(r.totals.plays).toBe(3);
    await expectCode(playbackReport(deps, priya, { orgId, from: '2026-09-30', to: '2026-10-01', siteId: pune, screenId: null }), 'permission-denied');
    await expectCode(
      playbackReport(deps, priya, { orgId, from: '2026-09-30', to: '2026-10-01', siteId: null, screenId: players.lobby!.screenId }),
      'permission-denied',
    );
    await expectCode(playbackReport(deps, user('eve'), { orgId, from: '2026-09-30', to: '2026-10-01', siteId: null, screenId: null }), 'permission-denied');
    await expectCode(playbackReport(deps, alice, { orgId, from: '2026-01-01', to: '2026-10-01', siteId: null, screenId: null }), 'invalid-argument');
    await enableReports(false);
    await expectCode(playbackReport(deps, alice, { orgId, from: '2026-09-30', to: '2026-10-01', siteId: null, screenId: null }), 'permission-denied');
  });
});
