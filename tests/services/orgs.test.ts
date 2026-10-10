import { beforeEach, describe, expect, it } from 'vitest';
import {
  paths,
  type AuditDoc,
  type EntitlementsDoc,
  type MemberDoc,
  type OrgDoc,
  type UserProfileDoc,
} from '@visione-x/shared';
import { verifyAuditChain } from '../../functions/src/lib/audit';
import * as members from '../../functions/src/members/members';
import { reviewOrgSignup, setOrgStatus } from '../../functions/src/orgs/review';
import { deleteSite, updateOrgSettings, upsertSite } from '../../functions/src/orgs/settings';
import { resubmitOrgSignup, submitOrgSignup } from '../../functions/src/orgs/signup';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const details = {
  orgName: 'Acme Displays',
  contactName: 'Asha Patil',
  phone: '+91 98200 12345',
  city: 'Pune',
  stateCode: '27',
  expectedScreens: 12,
  timezone: 'Asia/Kolkata',
};

const alice = user('alice');

async function read<T>(path: string) {
  return (await db.doc(path).get()).data() as T | undefined;
}

async function approvedOrg() {
  const { orgId, requestId } = await submitOrgSignup(deps, alice, details);
  await reviewOrgSignup(deps, superadmin, { requestId, decision: 'approve' });
  return orgId;
}

beforeEach(resetEmulator);

describe('organization signup and approval', () => {
  it('requires a verified email', async () => {
    await expectCode(submitOrgSignup(deps, user('bob', { emailVerified: false }), details), 'failed-precondition');
  });

  it('creates a pending org with the requester as owner', async () => {
    const { orgId } = await submitOrgSignup(deps, alice, details);
    const org = await read<OrgDoc>(paths.org(orgId));
    const owner = await read<MemberDoc>(paths.member(orgId, 'alice'));
    const profile = await read<UserProfileDoc>(paths.userProfile('alice'));
    expect(org?.status).toBe('pending');
    expect(owner?.role).toBe('owner');
    expect(owner?.permissions).toContain('billing.manage');
    expect(profile?.memberships[orgId]?.orgStatus).toBe('pending');
  });

  it('allows only one open request per user', async () => {
    await submitOrgSignup(deps, alice, details);
    await expectCode(submitOrgSignup(deps, alice, details), 'already-exists');
  });

  it('only staff with org.approve can review', async () => {
    const { requestId } = await submitOrgSignup(deps, alice, details);
    await expectCode(reviewOrgSignup(deps, alice, { requestId, decision: 'approve' }), 'permission-denied');
    await expectCode(
      reviewOrgSignup(deps, user('sup', { platformRole: 'support' }), { requestId, decision: 'approve' }),
      'permission-denied',
    );
  });

  it('approval activates the org with a 14-day trial and trial entitlements', async () => {
    const orgId = await approvedOrg();
    const org = await read<OrgDoc>(paths.org(orgId));
    const ent = await read<EntitlementsDoc>(paths.orgEntitlements(orgId));
    const profile = await read<UserProfileDoc>(paths.userProfile('alice'));
    expect(org?.status).toBe('active');
    expect(ent?.planId).toBe('trial');
    expect(ent?.limits.screens).toBe(2);
    expect(ent?.features).toContain('media.basic');
    expect(ent?.features).not.toContain('report.proofOfPlay'); // planned, not released
    expect(profile?.memberships[orgId]?.orgStatus).toBe('active');
  });

  it('supports request-info → resubmit → reject', async () => {
    const { orgId, requestId } = await submitOrgSignup(deps, alice, details);
    await reviewOrgSignup(deps, superadmin, {
      requestId,
      decision: 'request_info',
      message: 'Please add your GSTIN.',
    });
    expect((await read<OrgDoc>(paths.org(orgId)))?.status).toBe('info_requested');

    await expectCode(
      resubmitOrgSignup(deps, user('mallory'), { requestId, details, response: 'mine now' }),
      'permission-denied',
    );
    await resubmitOrgSignup(deps, alice, {
      requestId,
      details: { ...details, gstin: '27AAPFU0939F1ZV' },
      response: 'Added.',
    });
    expect((await read<OrgDoc>(paths.org(orgId)))?.status).toBe('pending');

    await reviewOrgSignup(deps, superadmin, { requestId, decision: 'reject', message: 'Not eligible.' });
    expect((await read<OrgDoc>(paths.org(orgId)))?.status).toBe('rejected');
    await expectCode(reviewOrgSignup(deps, superadmin, { requestId, decision: 'approve' }), 'failed-precondition');
  });

  it('pending orgs cannot make changes', async () => {
    const { orgId } = await submitOrgSignup(deps, alice, details);
    await expectCode(
      upsertSite(deps, alice, { orgId, name: 'HQ', timezone: 'Asia/Kolkata' }),
      'failed-precondition',
    );
  });

  it('suspend and reactivate', async () => {
    const orgId = await approvedOrg();
    await expectCode(setOrgStatus(deps, alice, { orgId, action: 'suspend', reason: 'testing' }), 'permission-denied');
    await setOrgStatus(deps, superadmin, { orgId, action: 'suspend', reason: 'Payment overdue' });
    expect((await read<OrgDoc>(paths.org(orgId)))?.status).toBe('suspended');
    await expectCode(
      updateOrgSettings(deps, alice, { orgId, name: 'Acme', timezone: 'Asia/Kolkata' }),
      'failed-precondition',
    );
    await setOrgStatus(deps, superadmin, { orgId, action: 'reactivate', reason: 'Paid' });
    expect((await read<OrgDoc>(paths.org(orgId)))?.status).toBe('active');
  });
});

describe('members and invitations', () => {
  it('invite → accept gives the invited role and permissions', async () => {
    const orgId = await approvedOrg();
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'bob@example.com', role: 'editor' });

    await expectCode(members.acceptInvite(deps, user('eve'), { token }), 'permission-denied');
    await members.acceptInvite(deps, user('bob'), { token });

    const bob = await read<MemberDoc>(paths.member(orgId, 'bob'));
    expect(bob?.role).toBe('editor');
    expect(bob?.permissions).toContain('content.publish');
    expect(bob?.permissions).not.toContain('member.manage');
    await expectCode(members.acceptInvite(deps, user('bob'), { token }), 'not-found');
  });

  it('expired invitations cannot be accepted', async () => {
    const orgId = await approvedOrg();
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'bob@example.com', role: 'viewer' });
    advance(8 * 86_400_000);
    await expectCode(members.acceptInvite(deps, user('bob'), { token }), 'deadline-exceeded');
  });

  it('editors cannot invite; admins cannot create owners', async () => {
    const orgId = await approvedOrg();
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'bob@example.com', role: 'editor' });
    await members.acceptInvite(deps, user('bob'), { token });
    await expectCode(
      members.inviteMember(deps, user('bob'), { orgId, email: 'x@example.com', role: 'viewer' }),
      'permission-denied',
    );

    const { token: t2 } = await members.inviteMember(deps, alice, { orgId, email: 'carol@example.com', role: 'admin' });
    await members.acceptInvite(deps, user('carol'), { token: t2 });
    await expectCode(
      members.updateMemberRole(deps, user('carol'), { orgId, uid: 'bob', role: 'owner' }),
      'permission-denied',
    );
  });

  it('enforces the plan user limit (trial: 3 users incl. pending invites)', async () => {
    const orgId = await approvedOrg();
    await members.inviteMember(deps, alice, { orgId, email: 'b@example.com', role: 'viewer' });
    await members.inviteMember(deps, alice, { orgId, email: 'c@example.com', role: 'viewer' });
    await expectCode(
      members.inviteMember(deps, alice, { orgId, email: 'd@example.com', role: 'viewer' }),
      'resource-exhausted',
    );
  });

  it('keeps at least one owner', async () => {
    const orgId = await approvedOrg();
    await expectCode(members.removeMember(deps, alice, { orgId, uid: 'alice' }), 'failed-precondition');
    await expectCode(
      members.updateMemberRole(deps, alice, { orgId, uid: 'alice', role: 'admin' }),
      'failed-precondition',
    );
  });

  it('removing a member clears their profile entry', async () => {
    const orgId = await approvedOrg();
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'bob@example.com', role: 'viewer' });
    await members.acceptInvite(deps, user('bob'), { token });
    await members.removeMember(deps, alice, { orgId, uid: 'bob' });
    const profile = await read<UserProfileDoc>(paths.userProfile('bob'));
    expect(profile?.memberships[orgId]).toBeUndefined();
  });
});

describe('sites', () => {
  it('owners manage sites; viewers cannot', async () => {
    const orgId = await approvedOrg();
    const { siteId } = await upsertSite(deps, alice, { orgId, name: 'Pune HQ', timezone: 'Asia/Kolkata' });
    await upsertSite(deps, alice, { orgId, siteId, name: 'Pune Head Office', timezone: 'Asia/Kolkata' });
    expect((await db.doc(paths.site(orgId, siteId)).get()).get('name')).toBe('Pune Head Office');

    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'bob@example.com', role: 'viewer' });
    await members.acceptInvite(deps, user('bob'), { token });
    await expectCode(deleteSite(deps, user('bob'), { orgId, siteId }), 'permission-denied');
    await deleteSite(deps, alice, { orgId, siteId });
    expect((await db.doc(paths.site(orgId, siteId)).get()).exists).toBe(false);
  });
});

describe('audit log', () => {
  it('records every action in an intact hash chain', async () => {
    const orgId = await approvedOrg();
    await upsertSite(deps, alice, { orgId, name: 'HQ', timezone: 'Asia/Kolkata' });

    const result = await verifyAuditChain(db, orgId);
    expect(result).toEqual({ ok: true, count: 3 });
    const actions = (await db.collection('auditLogs').where('chainId', '==', orgId).orderBy('seq').get()).docs.map(
      (d) => (d.data() as AuditDoc).action,
    );
    expect(actions).toEqual(['org.signup.submitted', 'org.signup.approve', 'site.created']);
  });

  it('detects tampering', async () => {
    const orgId = await approvedOrg();
    const first = (await db.collection('auditLogs').where('chainId', '==', orgId).where('seq', '==', 1).get()).docs[0]!;
    await first.ref.update({ actorId: 'someone-else' });
    expect(await verifyAuditChain(db, orgId)).toEqual({ ok: false, brokenAtSeq: 1 });
  });
});
