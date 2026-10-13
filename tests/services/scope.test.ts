import { beforeEach, describe, expect, it } from 'vitest';
import { EMERGENCY_CONFIRM_PHRASE, paths, type MemberDoc, type ScreenDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as layouts from '../../functions/src/content/layouts';
import * as schedules from '../../functions/src/content/schedules';
import * as members from '../../functions/src/members/members';
import * as commands from '../../functions/src/ops/commands';
import * as emergency from '../../functions/src/ops/emergency';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { upsertSite } from '../../functions/src/orgs/settings';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as screens from '../../functions/src/screens/screens';
import * as sensors from '../../functions/src/sensors/sensors';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice'); // owner, all sites
const priya = user('priya'); // admin limited to Pune
let orgId: string;
let pune: string;
let mumbai: string;

async function pair(by: typeof alice, siteId: string, name: string): Promise<string> {
  const reg = await handle(deps, {
    method: 'POST', path: '/api/v1/devices/register', headers: {}, ip: `10.0.0.${Math.floor(Math.random() * 200)}`,
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '11', sdkInt: 30, appVersion: '0.6.0', display: { width: 1920, height: 1080 } } },
  });
  const { pairingCode } = reg.body as { pairingCode: string };
  const { screenId } = await screens.claimDevice(deps, by, {
    orgId, pairingCode, name, siteId, groupIds: [], orientation: 'landscape', resolution: { width: 1920, height: 1080 },
  });
  return screenId;
}

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Two Cities', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
  ({ siteId: pune } = await upsertSite(deps, alice, { orgId, name: 'Pune', timezone: 'Asia/Kolkata' }));
  ({ siteId: mumbai } = await upsertSite(deps, alice, { orgId, name: 'Mumbai', timezone: 'Asia/Kolkata' }));
  const { token } = await members.inviteMember(deps, alice, { orgId, email: 'priya@example.com', role: 'admin', siteScope: [pune] });
  await members.acceptInvite(deps, priya, { token });
});

describe('site-scoped members', () => {
  it('get their sites from the invitation; owners cannot be scoped', async () => {
    expect(((await db.doc(paths.member(orgId, 'priya')).get()).data() as MemberDoc).siteScope).toEqual([pune]);
    await expectCode(members.setMemberSites(deps, alice, { orgId, uid: 'alice', siteScope: [pune] }), 'invalid-argument');
    await expectCode(members.inviteMember(deps, alice, { orgId, email: 'x@example.com', role: 'owner', siteScope: [pune] }), 'invalid-argument');
  });

  it('manage only their sites’ screens and lose org-wide powers', async () => {
    const mumbaiScreen = await pair(alice, mumbai, 'Mumbai lobby');
    await expectCode(pair(priya, mumbai, 'Sneaky'), 'permission-denied');
    const puneScreen = await pair(priya, pune, 'Pune lobby');

    const update = { orgId, name: 'Renamed', siteId: mumbai, groupIds: [], orientation: 'landscape' as const, resolution: { width: 1920, height: 1080 }, defaultPlaylistId: null };
    await expectCode(screens.updateScreen(deps, priya, { ...update, screenId: mumbaiScreen }), 'permission-denied');
    await expectCode(screens.updateScreen(deps, priya, { ...update, screenId: puneScreen }), 'permission-denied'); // moving it out of scope
    await expectCode(commands.sendScreenCommand(deps, priya, { orgId, screenId: mumbaiScreen, type: 'refresh' }), 'permission-denied');
    await expectCode(screens.removeScreen(deps, priya, { orgId, screenId: mumbaiScreen }), 'permission-denied');

    // Org-wide powers are gone even though the admin role includes them.
    await expectCode(members.inviteMember(deps, priya, { orgId, email: 'y@example.com', role: 'viewer', siteScope: [] }), 'permission-denied');
    await expectCode(upsertSite(deps, priya, { orgId, name: 'New city', timezone: 'Asia/Kolkata' }), 'permission-denied');
    await upsertSite(deps, priya, { orgId, siteId: pune, name: 'Pune Central', timezone: 'Asia/Kolkata' });
  });

  it('publish, schedule and override only within their sites', async () => {
    const mumbaiScreen = await pair(alice, mumbai, 'Mumbai lobby');
    const puneScreen = await pair(priya, pune, 'Pune lobby');
    const { playlistId } = await layouts.savePlaylist(deps, alice, {
      orgId, name: 'Promo', items: [{ id: 'w', content: { kind: 'widget', widget: { type: 'text', text: 'Hi', style: {} } }, durationSec: 10, transition: 'none' }],
    });

    expect(await screens.publishScreens(deps, priya, { orgId, screenIds: [] })).toEqual({ published: 1 });
    const version = async (id: string) => ((await db.doc(paths.screen(orgId, id)).get()).data() as ScreenDoc).manifestVersion;
    expect(await version(puneScreen)).toBe(1);
    expect(await version(mumbaiScreen)).toBe(0);
    await expectCode(screens.publishScreens(deps, priya, { orgId, screenIds: [mumbaiScreen] }), 'permission-denied');

    const schedule = {
      orgId, name: 'Weekdays', playlistId, priority: 10, timezone: 'Asia/Kolkata', startDate: null, endDate: null,
      daysOfWeek: [], windowStart: null, windowEnd: null, enabled: true,
    };
    await expectCode(schedules.saveSchedule(deps, priya, { ...schedule, target: { kind: 'all' } }), 'permission-denied');
    await expectCode(schedules.saveSchedule(deps, priya, { ...schedule, target: { kind: 'sites', ids: [mumbai] } }), 'permission-denied');
    await schedules.saveSchedule(deps, priya, { ...schedule, target: { kind: 'sites', ids: [pune] } });

    const override = { orgId, name: 'Fire drill', content: { kind: 'message' as const, text: 'Evacuate', background: '#B91C1C', color: '#FFFFFF' }, durationMinutes: 10, confirm: EMERGENCY_CONFIRM_PHRASE };
    await expectCode(emergency.triggerEmergency(deps, priya, { ...override, target: { kind: 'all' } }), 'permission-denied');
    expect((await emergency.triggerEmergency(deps, priya, { ...override, target: { kind: 'sites', ids: [pune] } })).screens).toBe(1);
  });

  it('see and manage only their sites’ sensors; widening scope again works', async () => {
    const input = { orgId, name: 'Fridge', offlineAfterMin: 15, enabled: true };
    await expectCode(sensors.saveSensorDevice(deps, priya, { ...input, siteId: mumbai }), 'permission-denied');
    await expectCode(sensors.saveSensorDevice(deps, priya, { ...input, siteId: null }), 'permission-denied');
    const { sensorDeviceId } = await sensors.saveSensorDevice(deps, alice, { ...input, siteId: mumbai });
    await expectCode(sensors.rotateSensorKey(deps, priya, { orgId, sensorDeviceId }), 'permission-denied');

    await members.setMemberSites(deps, alice, { orgId, uid: 'priya', siteScope: [] });
    await sensors.rotateSensorKey(deps, priya, { orgId, sensorDeviceId });
  });
});

describe('platform staff commands', () => {
  it('device.command staff can command any screen (audited); other staff cannot', async () => {
    const screenId = await pair(alice, mumbai, 'Mumbai lobby');
    const ops = user('ops1', { platformRole: 'ops' });
    const { commandId } = await commands.sendScreenCommand(deps, ops, { orgId, screenId, type: 'diagnostics' });
    expect((await db.doc(paths.command(orgId, screenId, commandId)).get()).exists).toBe(true);
    const audit = (await db.collection(paths.auditLogs()).where('chainId', '==', orgId).where('action', '==', 'screen.command.diagnostics').get()).docs;
    expect(audit[0]?.data()).toMatchObject({ actorType: 'platform_user', actorId: 'ops1' });
    await expectCode(commands.sendScreenCommand(deps, user('sup', { platformRole: 'support' }), { orgId, screenId, type: 'refresh' }), 'permission-denied');
  });
});
