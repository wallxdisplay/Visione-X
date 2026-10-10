import { beforeEach, describe, expect, it } from 'vitest';
import { Manifest, resolvePlaylist } from '@visione-x/layout-spec';
import {
  EMERGENCY_CONFIRM_PHRASE,
  OFFLINE_AFTER_MS,
  TriggerEmergencyInput,
  paths,
  type DeviceStateResponse,
  type NotificationDoc,
  type ScreenCommandDoc,
  type ScreenDoc,
} from '@visione-x/shared';
import { handle } from '../../functions/src/api/router';
import * as layouts from '../../functions/src/content/layouts';
import * as schedules from '../../functions/src/content/schedules';
import * as commands from '../../functions/src/ops/commands';
import * as emergency from '../../functions/src/ops/emergency';
import { runMonitor } from '../../functions/src/ops/monitor';
import * as members from '../../functions/src/members/members';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { updateOrgSettings } from '../../functions/src/orgs/settings';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as screens from '../../functions/src/screens/screens';
import { advance, bucket, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
let orgId: string;
let screenId: string;
let auth: string;
let playlistId: string;

const api = (method: string, path: string, body: unknown = {}) =>
  handle(deps, { method, path, headers: { authorization: auth }, body, ip: '10.0.0.9' });
const manifest = async () => Manifest.parse((await api('GET', '/api/v1/devices/manifest')).body);
const screenDoc = async () => (await db.doc(paths.screen(orgId, screenId)).get()).data() as ScreenDoc;
const notifications = async () =>
  (await db.collection(paths.notifications(orgId)).orderBy('createdAt').get()).docs.map((d) => d.data() as NotificationDoc);

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

  const reg = await handle(deps, {
    method: 'POST',
    path: '/api/v1/devices/register',
    headers: {},
    ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '11', sdkInt: 30, appVersion: '0.4.0', display: { width: 1920, height: 1080 } } },
  });
  const b = reg.body as { deviceId: string; deviceSecret: string; pairingCode: string };
  auth = `Device ${b.deviceId}:${b.deviceSecret}`;
  ({ screenId } = await screens.claimDevice(deps, alice, {
    orgId,
    pairingCode: b.pairingCode,
    name: 'Lobby',
    siteId: null,
    groupIds: [],
    orientation: 'landscape',
    resolution: { width: 1920, height: 1080 },
  }));
  ({ playlistId } = await layouts.savePlaylist(deps, alice, {
    orgId,
    name: 'Regular',
    items: [{ id: 'w', content: { kind: 'widget', widget: { type: 'text', text: 'Hello', style: {} } }, durationSec: 10, transition: 'none' }],
  }));
  await schedules.saveSchedule(deps, alice, {
    orgId, name: 'Always', playlistId, target: { kind: 'all' }, priority: 10, timezone: 'Asia/Kolkata',
    startDate: null, endDate: null, daysOfWeek: [], windowStart: null, windowEnd: null, enabled: true,
  });
  await screens.publishScreens(deps, alice, { orgId, screenIds: [] });
});

describe('emergency override', () => {
  it('requires the typed confirmation phrase', () => {
    const base = { orgId: 'o', name: 'Fire drill', content: { kind: 'message', text: 'Evacuate' }, target: { kind: 'all' }, durationMinutes: 30 };
    expect(TriggerEmergencyInput.safeParse({ ...base, confirm: 'yes' }).success).toBe(false);
    expect(TriggerEmergencyInput.safeParse({ ...base, confirm: EMERGENCY_CONFIRM_PHRASE }).success).toBe(true);
  });

  it('takes over the screen with a message, then restores normal content when ended', async () => {
    const before = await manifest();
    const { emergencyId, screens: count } = await emergency.triggerEmergency(deps, alice, {
      orgId, name: 'Fire drill', content: { kind: 'message', text: 'कृपया बाहेर पडा · Please evacuate', background: '#B91C1C', color: '#FFFFFF' },
      target: { kind: 'screens', ids: [screenId] }, durationMinutes: null, confirm: EMERGENCY_CONFIRM_PHRASE,
    });
    expect(count).toBe(1);

    const during = await manifest();
    expect(during.version).toBe(before.version + 1);
    expect(during.emergency?.id).toBe(emergencyId);
    // The same resolver the player runs picks the emergency playlist.
    expect(resolvePlaylist(during, Date.now())).toMatchObject({ source: 'emergency', playlistId: during.emergency!.playlistId });
    const msg = during.playlists.find((p) => p.id === during.emergency!.playlistId)!;
    expect(JSON.stringify(msg.items[0]!.content)).toContain('Please evacuate');

    await emergency.endEmergency(deps, alice, { orgId, emergencyId });
    const after = await manifest();
    expect(after.emergency).toBeNull();
    expect(resolvePlaylist(after, Date.now()).playlistId).toBe(playlistId);
    expect((await notifications()).map((n) => n.type)).toEqual(['emergency_started', 'emergency_ended']);
  });

  it('timed overrides are ended by the monitor; viewers cannot trigger', async () => {
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'v@example.com', role: 'viewer' });
    await members.acceptInvite(deps, user('v'), { token });
    const input = {
      orgId, name: 'Promo takeover', content: { kind: 'playlist' as const, playlistId },
      target: { kind: 'all' as const }, durationMinutes: 10, confirm: EMERGENCY_CONFIRM_PHRASE,
    };
    await expectCode(emergency.triggerEmergency(deps, user('v'), input), 'permission-denied');
    await emergency.triggerEmergency(deps, alice, input);
    expect((await manifest()).emergency).not.toBeNull();

    advance(11 * 60_000);
    expect((await runMonitor(deps)).emergencies).toBe(1);
    expect((await manifest()).emergency).toBeNull();
  });
});

describe('remote commands', () => {
  it('queue → delivered on poll → result with screenshot', async () => {
    const { commandId } = await commands.sendScreenCommand(deps, alice, { orgId, screenId, type: 'screenshot' });
    expect(((await api('GET', '/api/v1/devices/me')).body as DeviceStateResponse).commandsPending).toBe(1);

    const taken = (await api('GET', '/api/v1/devices/commands')).body as { commands: Array<{ id: string; type: string }> };
    expect(taken.commands).toEqual([expect.objectContaining({ id: commandId, type: 'screenshot' })]);
    expect((await screenDoc()).pendingCommands).toBe(0);

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
    const res = await api('POST', '/api/v1/devices/commands/result', { id: commandId, status: 'done', result: { width: 1920 }, screenshotJpegBase64: jpeg });
    expect(res.status).toBe(200);
    const cmd = (await db.doc(paths.command(orgId, screenId, commandId)).get()).data() as ScreenCommandDoc;
    expect(cmd).toMatchObject({ status: 'done', result: { width: 1920 } });
    expect((await bucket.file(cmd.screenshotPath!).exists())[0]).toBe(true);
    // A second report for the same command is refused.
    expect((await api('POST', '/api/v1/devices/commands/result', { id: commandId, status: 'done', result: null, screenshotJpegBase64: null })).status).toBe(404);
  });

  it('rejects non-JPEG screenshots, expires stale commands, and checks permission', async () => {
    const { commandId } = await commands.sendScreenCommand(deps, alice, { orgId, screenId, type: 'screenshot' });
    await api('POST', '/api/v1/devices/commands/result', { id: commandId, status: 'done', result: null, screenshotJpegBase64: Buffer.from('<svg/>').toString('base64') });
    expect(((await db.doc(paths.command(orgId, screenId, commandId)).get()).data() as ScreenCommandDoc).screenshotPath).toBeNull();

    const { commandId: stale } = await commands.sendScreenCommand(deps, alice, { orgId, screenId, type: 'refresh' });
    advance(31 * 60_000);
    await runMonitor(deps);
    expect(((await db.doc(paths.command(orgId, screenId, stale)).get()).data() as ScreenCommandDoc).status).toBe('expired');

    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'e@example.com', role: 'editor' });
    await members.acceptInvite(deps, user('e'), { token });
    await expectCode(commands.sendScreenCommand(deps, user('e'), { orgId, screenId, type: 'reboot' }), 'permission-denied');
  });
});

describe('monitoring and notifications', () => {
  it('raises one offline alert, clears it on heartbeat with a back-online notice', async () => {
    await db.doc(paths.screen(orgId, screenId)).update({ lastSeen: Date.now() - OFFLINE_AFTER_MS - 60_000 });
    advance(0);
    const fakeNow = Date.now();
    const monitorDeps = { ...deps, now: () => fakeNow };
    expect((await runMonitor(monitorDeps)).offline).toBe(1);
    expect((await runMonitor(monitorDeps)).offline).toBe(0); // no duplicate alert
    expect((await screenDoc()).offlineAlertedAt).toBe(fakeNow);

    const hb = { appVersion: '0.4.0', display: { width: 1920, height: 1080 }, storageFreeMb: 100, playing: null, manifestVersion: 1, errors: [] };
    await api('POST', '/api/v1/devices/heartbeat', hb);
    expect((await screenDoc()).offlineAlertedAt).toBeNull();
    // (The two runs use different clocks here, so compare as a set.)
    const types = (await notifications()).map((n) => n.type).sort();
    expect(types).toEqual(['screen_offline', 'screen_online']);

    const ids = (await notifications()).map((n) => n.id);
    await commands.markNotificationsRead(deps, alice, { orgId, notificationIds: ids });
    expect((await notifications()).every((n) => n.readBy.includes('alice'))).toBe(true);
  });
});

describe('publish approvals', () => {
  it('needs the plan feature; editor publishes become requests that an approver decides', async () => {
    // Trial plan does not include approvals.
    await expectCode(updateOrgSettings(deps, alice, { orgId, name: 'Acme', timezone: 'Asia/Kolkata', requirePublishApproval: true }), 'permission-denied');

    // Simulate Professional: grant the feature.
    const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
    await db.doc(paths.orgEntitlements(orgId)).update({ features: [...ent.features, 'content.approvals'] });
    await updateOrgSettings(deps, alice, { orgId, name: 'Acme', timezone: 'Asia/Kolkata', requirePublishApproval: true });

    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'ed@example.com', role: 'editor' });
    await members.acceptInvite(deps, user('ed'), { token });
    const before = (await screenDoc()).manifestVersion;

    const req = await screens.publishScreens(deps, user('ed'), { orgId, screenIds: [], note: 'Diwali menu' });
    expect(req.published).toBe(0);
    expect(req.approvalId).toBeTruthy();
    expect((await screenDoc()).manifestVersion).toBe(before);

    await expectCode(screens.reviewPublish(deps, user('ed'), { orgId, approvalId: req.approvalId!, decision: 'approve' }), 'permission-denied');
    expect(await screens.reviewPublish(deps, alice, { orgId, approvalId: req.approvalId!, decision: 'approve' })).toEqual({ published: 1 });
    expect((await screenDoc()).manifestVersion).toBe(before + 1);
    await expectCode(screens.reviewPublish(deps, alice, { orgId, approvalId: req.approvalId!, decision: 'reject', note: 'too late' }), 'failed-precondition');

    // Approvers (owner) publish directly even with approvals on.
    expect((await screens.publishScreens(deps, alice, { orgId, screenIds: [] })).published).toBe(1);
  });
});
