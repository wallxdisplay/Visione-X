import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type MemberDoc } from '@wallx-play/shared';
import * as members from '../../functions/src/members/members';
import {
  deliverNotificationEmail,
  emailRecipients,
} from '../../functions/src/notifications/emails';
import { notify } from '../../functions/src/lib/notify';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { updateOrgSettings } from '../../functions/src/orgs/settings';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { db, deps, outbox, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
let orgId: string;
let requestId: string;

async function addNotification(
  type: Parameters<typeof notify>[3],
  params: Record<string, string | number>,
) {
  const batch = db.batch();
  notify(batch, db, orgId, type, params, '/screens', deps.now());
  await batch.commit();
  const snap = await db
    .collection(paths.notifications(orgId))
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  return snap.docs[0]!.id;
}

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
  orgId = r.orgId;
  requestId = r.requestId;
});

describe('signup decision emails', () => {
  it('emails the applicant when the org is approved', async () => {
    const res = await reviewOrgSignup(deps, superadmin, { requestId, decision: 'approve' });
    expect(res).toEqual({ status: 'active', emailed: true });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toEqual(['alice@example.com']);
    expect(outbox[0]!.subject).toContain('Acme is approved');
  });

  it('includes the reviewer message when more information is requested', async () => {
    await reviewOrgSignup(deps, superadmin, {
      requestId,
      decision: 'request_info',
      message: 'Please share your GSTIN.',
    });
    expect(outbox[0]!.subject).toContain('More information needed');
    expect(outbox[0]!.text).toContain('Please share your GSTIN.');
  });
});

describe('invitation and alert emails', () => {
  beforeEach(async () => {
    await reviewOrgSignup(deps, superadmin, { requestId, decision: 'approve' });
    outbox.length = 0;
  });

  it('emails the invitation link to the invitee', async () => {
    const res = await members.inviteMember(deps, alice, {
      orgId,
      email: 'bob@example.com',
      role: 'viewer',
    });
    expect(res.emailed).toBe(true);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toEqual(['bob@example.com']);
    expect(outbox[0]!.replyTo).toBe('alice@example.com');
    expect(outbox[0]!.action?.url).toMatch(new RegExp(`/invite/${res.token}$`));
  });

  it('emails an alert once, only to members who handle it', async () => {
    const { token } = await members.inviteMember(deps, alice, {
      orgId,
      email: 'bob@example.com',
      role: 'viewer',
    });
    await members.acceptInvite(deps, user('bob'), { token });
    outbox.length = 0;

    const id = await addNotification('screen_offline', {
      screen: 'Lobby',
      lastSeen: deps.now() - 600_000,
    });
    expect(await deliverNotificationEmail(deps, orgId, id)).toBe(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toEqual(['alice@example.com']); // viewer bob cannot manage screens
    expect(outbox[0]!.subject).toBe('Screen offline: Lobby · Acme');

    // A retried event does not send again.
    expect(await deliverNotificationEmail(deps, orgId, id)).toBe(0);
    expect(outbox).toHaveLength(1);
  });

  it('keeps informational notifications in-app only', async () => {
    const id = await addNotification('screen_online', { screen: 'Lobby' });
    expect(await deliverNotificationEmail(deps, orgId, id)).toBe(0);
    expect(outbox).toHaveLength(0);
  });

  it('respects the organization setting', async () => {
    await updateOrgSettings(deps, alice, {
      orgId,
      name: 'Acme',
      timezone: 'Asia/Kolkata',
      emailNotifications: false,
    });
    const id = await addNotification('billing_past_due', {});
    expect(await deliverNotificationEmail(deps, orgId, id)).toBe(0);
    expect(outbox).toHaveLength(0);
  });
});

describe('emailRecipients', () => {
  const member = (email: string, extra: Partial<MemberDoc> = {}): MemberDoc => ({
    uid: email,
    email,
    role: 'admin',
    permissions: ['screen.manage'],
    siteScope: [],
    status: 'active',
    joinedAt: 0,
    invitedBy: null,
    ...extra,
  });

  it('skips support staff, site-scoped, disabled and duplicate members', () => {
    expect(
      emailRecipients(
        [
          member('a@x.com'),
          member('A@x.com'),
          member('support@wallx.in', { support: { grantId: 'g', expiresAt: 1 } }),
          member('site@x.com', { siteScope: ['s1'] }),
          member('off@x.com', { status: 'disabled' }),
          member('viewer@x.com', { permissions: ['screen.view'] }),
        ],
        'screen.manage',
      ),
    ).toEqual(['a@x.com']);
  });
});
