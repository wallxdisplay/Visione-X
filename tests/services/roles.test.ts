import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type InviteDoc, type MemberDoc } from '@wallx-play/shared';
import * as members from '../../functions/src/members/members';
import * as roles from '../../functions/src/members/roles';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { upsertSite } from '../../functions/src/orgs/settings';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice'); // owner
const ravi = user('ravi'); // will get a custom role
let orgId: string;

const member = async (uid: string) => (await db.doc(paths.member(orgId, uid)).get()).data() as MemberDoc;
const role = (over: Partial<Parameters<typeof roles.saveRole>[2]> = {}) =>
  roles.saveRole(deps, alice, { orgId, name: 'Store manager', description: 'Runs one store', permissions: ['screen.view', 'screen.command', 'content.publish'], ...over });

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Chai Point', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

describe('custom roles', () => {
  it('invite with a custom role; the member gets its permissions, and edits apply at once', async () => {
    const { roleId } = await role();
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'ravi@example.com', role: 'custom', customRoleId: roleId, siteScope: [] });
    expect(((await db.collection(paths.invites(orgId)).get()).docs[0]!.data() as InviteDoc).customRoleId).toBe(roleId);
    await members.acceptInvite(deps, ravi, { token });
    expect(await member('ravi')).toMatchObject({ role: 'custom', customRoleId: roleId, permissions: ['screen.view', 'screen.command', 'content.publish'] });

    // Stored in canonical order; holders updated in the same change.
    await role({ roleId, permissions: ['content.publish', 'media.view', 'screen.view'] });
    expect((await member('ravi')).permissions).toEqual(['screen.view', 'media.view', 'content.publish']);
    const audit = (await db.collection(paths.auditLogs()).where('chainId', '==', orgId).where('action', '==', 'role.updated').get()).docs;
    expect(audit[0]?.data().data).toMatchObject({ membersUpdated: 1 });

    // Back to a system role drops the custom role.
    await members.updateMemberRole(deps, alice, { orgId, uid: 'ravi', role: 'viewer' });
    const m = await member('ravi');
    expect(m.role).toBe('viewer');
    expect(m.customRoleId).toBeUndefined();
    await members.updateMemberRole(deps, alice, { orgId, uid: 'ravi', role: 'custom', customRoleId: roleId });
    expect((await member('ravi')).customRoleId).toBe(roleId);
  });

  it('refuses billing, built-in or duplicate names, and more than the limit', async () => {
    await expectCode(role({ permissions: ['billing.manage'] }), 'invalid-argument');
    await expectCode(role({ name: 'Admin' }), 'already-exists');
    await role();
    await expectCode(role({ name: 'store MANAGER' }), 'already-exists');
    for (let i = 1; i < 20; i++) await role({ name: `Role ${i}` });
    await expectCode(role({ name: 'One too many' }), 'resource-exhausted');
  });

  it('only member.manage holders manage roles; scoped admins cannot', async () => {
    const { siteId } = await upsertSite(deps, alice, { orgId, name: 'Pune', timezone: 'Asia/Kolkata' });
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'priya@example.com', role: 'admin', siteScope: [siteId] });
    await members.acceptInvite(deps, user('priya'), { token });
    await expectCode(roles.saveRole(deps, user('priya'), { orgId, name: 'Sneaky', description: '', permissions: ['screen.view'] }), 'permission-denied');
    await expectCode(roles.saveRole(deps, user('stranger'), { orgId, name: 'Sneaky', description: '', permissions: ['screen.view'] }), 'permission-denied');
  });

  it('cannot delete a role that members or pending invitations hold', async () => {
    const { roleId } = await role();
    const invite = await members.inviteMember(deps, alice, { orgId, email: 'ravi@example.com', role: 'custom', customRoleId: roleId, siteScope: [] });
    await expectCode(roles.deleteRole(deps, alice, { orgId, roleId }), 'failed-precondition');
    await members.acceptInvite(deps, ravi, { token: invite.token });
    await expectCode(roles.deleteRole(deps, alice, { orgId, roleId }), 'failed-precondition');
    await members.updateMemberRole(deps, alice, { orgId, uid: 'ravi', role: 'editor' });
    await roles.deleteRole(deps, alice, { orgId, roleId });
    expect((await db.doc(paths.role(orgId, roleId)).get()).exists).toBe(false);
    await expectCode(members.updateMemberRole(deps, alice, { orgId, uid: 'ravi', role: 'custom', customRoleId: roleId }), 'not-found');
  });
});
