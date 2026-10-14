import { beforeEach, describe, expect, it } from 'vitest';
import { OFFLINE_AFTER_MS, paths, type PlayStatsDoc, type ScreenDoc, type ScreenEventDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as members from '../../functions/src/members/members';
import { runMonitor } from '../../functions/src/ops/monitor';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { upsertSite } from '../../functions/src/orgs/settings';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { screenAnalytics } from '../../functions/src/reports/analytics';
import * as screens from '../../functions/src/screens/screens';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
const HOUR = 3_600_000;

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

const post = (player: { auth: string }, path: string, body: unknown) =>
  handle(deps, { method: 'POST', path, headers: { authorization: player.auth }, body, ip: '10.0.0.9' });
const heartbeat = (player: { auth: string }, extra: Record<string, unknown> = {}) =>
  post(player, '/api/v1/devices/heartbeat', { appVersion: '0.14.0', display: { width: 1920, height: 1080 }, storageFreeMb: 900, playing: null, manifestVersion: 1, errors: [], ...extra });
const events = async (screenId: string) =>
  (await db.collection(paths.screenEvents(orgId, screenId)).orderBy('at').get()).docs.map((d) => d.data() as ScreenEventDoc);
const day = async (screenId: string, date: string) => (await db.doc(paths.playStat(orgId, date, screenId)).get()).data() as PlayStatsDoc | undefined;

const setFeatures = async (add: string[], remove: string[] = []) => {
  const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
  const features = (ent.features as string[]).filter((f) => !remove.includes(f) && !add.includes(f));
  await db.doc(paths.orgEntitlements(orgId)).update({ features: [...features, ...add] });
};

let t0: number;
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
  t0 = deps.now(); // around 2026-10-01 09:00 UTC (14:30 in India)
  players.lobby = await pairScreen('Lobby', pune);
  players.cafe = await pairScreen('Cafe', mumbai);
  for (const p of Object.values(players)) await screens.authorizeScreen(deps, alice, { orgId, screenId: p.screenId }).catch(() => undefined);
});

describe('diagnostics history', () => {
  it('keeps errors, updates and offline/online only with screen diagnostics in the plan', async () => {
    await heartbeat(players.lobby!, { appVersion: '0.13.0', errors: ['2026-10-01T08:59:00Z network: timeout'] });
    expect(await events(players.lobby!.screenId)).toEqual([]);

    await setFeatures(['screen.diagnostics']);
    await heartbeat(players.lobby!, { appVersion: '0.13.0', errors: ['2026-10-01T08:59:00Z network: timeout', 'disk full'] });
    advance(1000);
    await heartbeat(players.lobby!, { appVersion: '0.14.0', vitals: { memAvailMb: 800, memTotalMb: 2000, deviceUptimeMin: 90, appUptimeMin: 30, network: 'wifi' } });
    const list = await events(players.lobby!.screenId);
    expect(list.map((e) => [e.type, e.message])).toEqual([
      ['error', 'network: timeout'],
      ['error', 'disk full'],
      ['updated', '0.13.0 → 0.14.0'],
    ]);
    expect((await day(players.lobby!.screenId, '2026-10-01'))?.errors).toBe(2);
    const screen = (await db.doc(paths.screen(orgId, players.lobby!.screenId)).get()).data() as ScreenDoc;
    expect(screen.health?.vitals).toEqual({ memAvailMb: 800, memTotalMb: 2000, deviceUptimeMin: 90, appUptimeMin: 30, network: 'wifi' });

    // Silent too long: an offline event; the next heartbeat adds "online".
    advance(OFFLINE_AFTER_MS + 60_000);
    expect((await runMonitor(deps)).offline).toBe(2);
    await heartbeat(players.lobby!);
    const types = (await events(players.lobby!.screenId)).map((e) => e.type);
    // "offline" is dated when the screen was last seen; "online" when it came back.
    expect(types).toContain('offline');
    expect(types.at(-1)).toBe('online');
    expect((await day(players.lobby!.screenId, '2026-10-01'))?.offline).toBe(1);
  });
});

describe('screen analytics', () => {
  const h0 = () => t0 - (t0 % HOUR);
  beforeEach(async () => {
    await setFeatures(['screen.diagnostics', 'report.proofOfPlay']);
    advance(3 * HOUR); // now 12:00 UTC; both screens exist for 3 hours today
    await post(players.lobby!, '/api/v1/devices/plays', {
      batchId: 'lobby-up-01',
      buckets: [{ hour: h0(), kind: 'media', id: 'm1', plays: 5, seconds: 50 }],
      uptime: [
        { hour: h0(), on: 3600, online: 1800 },
        { hour: h0() + HOUR, on: 3600, online: 3600 },
        { hour: h0() + 2 * HOUR, on: 1800, online: 0 },
      ],
    });
    await heartbeat(players.lobby!, { errors: ['oops'] });
  });

  it('shares of running and online time, errors and plays per screen and day', async () => {
    const r = await screenAnalytics(deps, alice, { orgId, from: '2026-10-01', to: '2026-10-01', siteId: null, screenId: null });
    const lobby = r.byScreen.find((s) => s.name === 'Lobby')!;
    expect(lobby.onShare).toBeCloseTo(9000 / 10800);
    expect(lobby.onlineShare).toBeCloseTo(5400 / 10800);
    expect(lobby).toMatchObject({ errors: 1, plays: 5, appVersion: '0.14.0' });
    // The cafe player sent no uptime (an older player): no share instead of 0%.
    expect(r.byScreen.find((s) => s.name === 'Cafe')).toMatchObject({ onShare: null, onlineShare: null });
    expect(r.totals).toMatchObject({ screens: 2, screensWithData: 1, errors: 1, plays: 5 });
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0]!.onShare).toBeCloseTo(9000 / 10800);
  });

  it('keeps uptime but not plays without proof-of-play, and limits scoped members', async () => {
    await setFeatures([], ['report.proofOfPlay']);
    await post(players.cafe!, '/api/v1/devices/plays', {
      batchId: 'cafe-up-001',
      buckets: [{ hour: h0(), kind: 'media', id: 'm1', plays: 9, seconds: 90 }],
      uptime: [{ hour: h0(), on: 3600, online: 3600 }],
    });
    const cafeDay = await day(players.cafe!.screenId, '2026-10-01');
    expect(cafeDay).toMatchObject({ onSeconds: 3600, onlineSeconds: 3600 });
    expect(cafeDay?.plays).toBeUndefined();

    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'priya@example.com', role: 'viewer', siteScope: [mumbai] });
    await members.acceptInvite(deps, user('priya'), { token });
    const r = await screenAnalytics(deps, user('priya'), { orgId, from: '2026-10-01', to: '2026-10-01', siteId: null, screenId: null });
    expect(r.byScreen.map((s) => s.name)).toEqual(['Cafe']);
    await expectCode(screenAnalytics(deps, user('priya'), { orgId, from: '2026-10-01', to: '2026-10-01', siteId: null, screenId: players.lobby!.screenId }), 'permission-denied');

    await setFeatures([], ['screen.diagnostics']);
    await expectCode(screenAnalytics(deps, alice, { orgId, from: '2026-10-01', to: '2026-10-01', siteId: null, screenId: null }), 'permission-denied');
  });
});
