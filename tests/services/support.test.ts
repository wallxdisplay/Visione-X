import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type MemberDoc, type SupportGrantDoc } from '@wallx-play/shared';
import * as layouts from '../../functions/src/content/layouts';
import * as members from '../../functions/src/members/members';
import { runMonitor } from '../../functions/src/ops/monitor';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as support from '../../functions/src/support/access';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const HOUR = 3_600_000;
const alice = user('alice'); // owner
const sam = user('sam', { platformRole: 'support' });
const ops = user('ops1', { platformRole: 'ops' });
let orgId: string;

const grant = async (id: string) => (await db.doc(paths.supportGrant(orgId, id)).get()).data() as SupportGrantDoc;
const member = async (uid: string) => (await db.doc(paths.member(orgId, uid)).get()).data() as MemberDoc | undefined;
const playlist = (actor: ReturnType<typeof user>) =>
  layouts.savePlaylist(deps, actor, { orgId, name: 'Fix', items: [{ id: 'i', content: { kind: 'widget', widget: { type: 'text', text: 'Hi', style: {} } }, durationSec: 10, transition: 'none' }] });

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Chai Point', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

describe('support access', () => {
  it('customer grant → staff opens → acts within the level → access ends on expiry', async () => {
    await expectCode(support.openSupportAccess(deps, sam, { orgId, grantId: 'none' }), 'not-found');
    const { grantId } = await support.grantSupportAccess(deps, alice, { orgId, level: 'edit', hours: 4, reason: 'Help with the menu board' });
    expect(await grant(grantId)).toMatchObject({ status: 'active', origin: 'customer', expiresAt: deps.now() + 4 * HOUR });

    await support.openSupportAccess(deps, sam, { orgId, grantId });
    expect(await member('sam')).toMatchObject({ role: 'editor', support: { grantId } });
    expect((await member('sam'))!.permissions).toContain('screen.command');
    expect((await grant(grantId)).openedBy).toEqual(['sam']);
    await playlist(sam); // can fix content
    await expectCode(members.inviteMember(deps, sam, { orgId, email: 'x@example.com', role: 'viewer', siteScope: [] }), 'permission-denied'); // never team/billing
    // Managed under Help & Support, not the Team page.
    await expectCode(members.updateMemberRole(deps, alice, { orgId, uid: 'sam', role: 'admin' }), 'failed-precondition');

    // Expired: refused at once, removed by the monitor.
    advance(4 * HOUR + 1);
    await expectCode(playlist(sam), 'permission-denied');
    expect((await runMonitor(deps)).supportExpired).toBe(1);
    expect(await member('sam')).toBeUndefined();
    expect((await grant(grantId)).status).toBe('expired');
    await expectCode(support.openSupportAccess(deps, sam, { orgId, grantId }), 'failed-precondition');
  });

  it('staff request needs the customer’s approval; declined requests give nothing', async () => {
    await expectCode(support.requestSupportAccess(deps, ops, { orgId, level: 'view', hours: 1, reason: 'Screen offline' }), 'permission-denied');
    const { grantId } = await support.requestSupportAccess(deps, sam, { orgId, level: 'view', hours: 1, reason: 'Customer called about a blank screen' });
    const notes = await db.collection(paths.notifications(orgId)).where('type', '==', 'support_access_requested').get();
    expect(notes.size).toBe(1);
    await expectCode(support.openSupportAccess(deps, sam, { orgId, grantId }), 'failed-precondition');

    await support.respondSupportRequest(deps, alice, { orgId, grantId, approve: true });
    await support.openSupportAccess(deps, sam, { orgId, grantId });
    expect((await member('sam'))!.role).toBe('viewer');
    await expectCode(playlist(sam), 'permission-denied'); // view only

    const second = await support.requestSupportAccess(deps, sam, { orgId, level: 'edit', hours: 4, reason: 'Need to republish content' });
    await support.respondSupportRequest(deps, alice, { orgId, grantId: second.grantId, approve: false });
    expect((await grant(second.grantId)).status).toBe('declined');
    await expectCode(support.respondSupportRequest(deps, alice, { orgId, grantId: second.grantId, approve: true }), 'failed-precondition');
  });

  it('the customer or a superadmin can end access now; emergency grants notify the customer', async () => {
    await expectCode(support.emergencySupportAccess(deps, sam, { orgId, level: 'edit', hours: 1, reason: 'Wrong content on all screens' }), 'permission-denied');
    const { grantId } = await support.emergencySupportAccess(deps, superadmin, { orgId, level: 'edit', hours: 1, reason: 'Wrong content on all screens' });
    expect((await db.collection(paths.notifications(orgId)).where('type', '==', 'support_access_granted').get()).size).toBe(1);
    await support.openSupportAccess(deps, sam, { orgId, grantId });

    await expectCode(support.revokeSupportAccess(deps, user('stranger'), { orgId, grantId }), 'permission-denied');
    await support.revokeSupportAccess(deps, alice, { orgId, grantId });
    expect(await member('sam')).toBeUndefined();
    expect((await grant(grantId)).status).toBe('revoked');
    const profile = (await db.doc(paths.userProfile('sam')).get()).data() as { memberships?: Record<string, unknown> };
    expect(profile.memberships?.[orgId]).toBeUndefined();
  });

  it('support staff do not count toward the plan’s user limit', async () => {
    const { grantId } = await support.grantSupportAccess(deps, alice, { orgId, level: 'view', hours: 1, reason: '' });
    await support.openSupportAccess(deps, sam, { orgId, grantId });
    // Trial plan: 3 users. Owner + 2 invites fit even with a support member present.
    await members.inviteMember(deps, alice, { orgId, email: 'b@example.com', role: 'viewer', siteScope: [] });
    await members.inviteMember(deps, alice, { orgId, email: 'c@example.com', role: 'viewer', siteScope: [] });
    await expectCode(members.inviteMember(deps, alice, { orgId, email: 'd@example.com', role: 'viewer', siteScope: [] }), 'resource-exhausted');
  });
});
