import { beforeEach, describe, expect, it } from 'vitest';
import * as billing from '../../functions/src/billing/billing';
import { orgActivity } from '../../functions/src/orgs/activity';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { requestSupportAccess } from '../../functions/src/support/access';
import { deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice'); // owner
const billingStaff = user('bill', { platformRole: 'billing', email: 'bill@wallx.example' });
const supportStaff = user('sup', { platformRole: 'support', email: 'sup@wallx.example' });
let orgId: string;

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Acme', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

describe('activity log', () => {
  it('shows members what happened without internal notes or staff emails', async () => {
    await billing.updateSubscription(deps, billingStaff, { orgId, planId: 'starter', interval: 'monthly', quantity: 2, customPriceMinor: null, discountBps: 0, repriceApps: false, reason: 'Internal: slow payer, watch closely' });
    await requestSupportAccess(deps, supportStaff, { orgId, level: 'view', hours: 4, reason: 'Checking the offline screen you reported' });

    const { entries, more } = await orgActivity(deps, alice, { orgId });
    expect(more).toBe(false);
    const sub = entries.find((e) => e.action === 'billing.subscription.updated')!;
    expect(sub).toMatchObject({ actorType: 'platform_user', actorEmail: null, reason: null });
    const support = entries.find((e) => e.action === 'support.access.requested')!;
    expect(support).toMatchObject({ actorEmail: null, reason: 'Checking the offline screen you reported' });
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort((a, b) => b - a)); // newest first
    expect(JSON.stringify(entries)).not.toContain('bill@wallx.example');
  });

  it('only members allowed to see the activity log', async () => {
    await expectCode(orgActivity(deps, user('mallory'), { orgId }), 'permission-denied');
  });
});
