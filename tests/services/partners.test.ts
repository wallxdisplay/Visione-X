import { beforeEach, describe, expect, it } from 'vitest';
import {
  paths,
  type AccountDoc,
  type EntitlementsDoc,
  type MemberDoc,
  type OrgDoc,
  type SubscriptionDoc,
  type UserProfileDoc,
} from '@wallx-play/shared';
import * as accounts from '../../functions/src/accounts/accounts';
import * as partners from '../../functions/src/accounts/partners';
import * as billing from '../../functions/src/billing/billing';
import * as members from '../../functions/src/members/members';
import { runMonitor } from '../../functions/src/ops/monitor';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const DAY = 86_400_000;
const billingStaff = user('bill', { platformRole: 'billing' });
const ravi = user('ravi'); // reseller owner
const sana = user('sana'); // reseller staff
const meera = user('meera'); // customer owner
let accountId: string;

const sub = async (orgId: string) => (await db.doc(paths.orgSubscription(orgId)).get()).data() as SubscriptionDoc;
const org = async (orgId: string) => (await db.doc(paths.org(orgId)).get()).data() as OrgDoc;
const member = async (orgId: string, uid: string) => (await db.doc(paths.member(orgId, uid)).get()).data() as MemberDoc | undefined;
const profile = async (uid: string) => (await db.doc(paths.userProfile(uid)).get()).data() as UserProfileDoc;

async function join(actor: ReturnType<typeof user>, role: 'owner' | 'staff', inviter = ravi) {
  const { token } = await partners.inviteAccountMember(deps, inviter, { accountId, email: actor.email!, role });
  return members.acceptInvite(deps, actor, { token });
}

const newCustomer = (over: Record<string, unknown> = {}) =>
  partners.createPartnerOrg(deps, ravi, {
    accountId,
    orgName: 'Kothari Sweets',
    contactName: 'Meera Kothari',
    phone: '+91 98200 11111',
    city: 'Nashik',
    stateCode: '27',
    timezone: 'Asia/Kolkata',
    ownerEmail: 'meera@example.com',
    planId: 'professional',
    quantity: 3,
    trial: true,
    ...over,
  });

beforeEach(async () => {
  await resetEmulator();
  ({ accountId } = await accounts.saveAccount(deps, superadmin, {
    name: 'Deccan Displays',
    contactName: 'Ravi',
    email: 'ravi@example.com',
    phone: '',
    city: 'Pune',
    gstin: null,
    status: 'active',
    notes: '',
    dealerDiscountBps: 2_000, // 20 % off list
    dealerPricesMinor: {},
  }));
  // WallX invites the reseller's first owner.
  const { token } = await partners.inviteAccountMember(deps, superadmin, { accountId, email: 'ravi@example.com', role: 'owner' });
  await members.acceptInvite(deps, ravi, { token });
});

describe('reseller team and customers', () => {
  it('the reseller creates a customer: approved at once, its team manages it, the customer owner is invited', async () => {
    expect((await profile('ravi')).accounts?.[accountId]).toMatchObject({ name: 'Deccan Displays', role: 'owner', portal: true });
    await join(sana, 'staff');
    await expectCode(partners.inviteAccountMember(deps, sana, { accountId, email: 'x@example.com', role: 'staff' }), 'permission-denied'); // staff cannot

    const { orgId, inviteToken } = await newCustomer();
    const o = await org(orgId);
    expect(o).toMatchObject({ status: 'active', parentAccountId: accountId, partnerAccess: true });
    expect(await sub(orgId)).toMatchObject({ planId: 'professional', quantity: 3, billedTo: accountId, status: 'trialing' });
    const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data() as EntitlementsDoc;
    expect(ent.limits.screens).toBe(3);
    for (const uid of ['ravi', 'sana']) {
      expect(await member(orgId, uid)).toMatchObject({ role: 'admin', partner: { accountId } });
      expect((await profile(uid)).memberships[orgId]).toMatchObject({ orgName: 'Kothari Sweets', role: 'admin' });
    }

    // The customer's owner accepts; partner records cannot be edited from the customer's Team page.
    await members.acceptInvite(deps, meera, { token: inviteToken! });
    expect(await member(orgId, 'meera')).toMatchObject({ role: 'owner' });
    await expectCode(members.removeMember(deps, meera, { orgId, uid: 'sana' }), 'failed-precondition');
    await expectCode(members.updateMemberRole(deps, meera, { orgId, uid: 'sana', role: 'viewer' }), 'failed-precondition');
    // Billing questions go to the reseller.
    await expectCode(billing.requestBillingChange(deps, meera, { orgId, kind: 'add_screens', quantity: 5, message: 'More please' }), 'failed-precondition');

    // The owner switches the reseller off and on again.
    await partners.setPartnerAccess(deps, meera, { orgId, enabled: false });
    expect(await member(orgId, 'sana')).toBeUndefined();
    expect((await profile('sana')).memberships[orgId]).toBeUndefined();
    await partners.setPartnerAccess(deps, meera, { orgId, enabled: true });
    expect(await member(orgId, 'sana')).toMatchObject({ partner: { accountId } });

    // Someone leaving the reseller loses access to its customers.
    await partners.removeAccountMember(deps, ravi, { accountId, uid: 'sana' });
    expect(await member(orgId, 'sana')).toBeUndefined();
    expect((await profile('sana')).accounts?.[accountId]).toBeUndefined();
    await expectCode(partners.removeAccountMember(deps, ravi, { accountId, uid: 'ravi' }), 'failed-precondition'); // last owner

    // An inactive reseller (or one without the portal) has no access.
    await accounts.saveAccount(deps, superadmin, { ...(await db.doc(paths.account(accountId)).get()).data() as AccountDoc, accountId, status: 'inactive' } as never);
    expect(await member(orgId, 'ravi')).toBeUndefined();
    expect((await profile('ravi')).accounts?.[accountId]).toMatchObject({ status: 'inactive' });
    await expectCode(newCustomer(), 'failed-precondition');
  });

  it('only the reseller’s team sees its customers', async () => {
    await newCustomer();
    await expectCode(partners.partnerOverview(deps, user('mallory'), { accountId }), 'permission-denied');
    const overview = await partners.partnerOverview(deps, ravi, { accountId });
    expect(overview.customers.map((c) => c.name)).toEqual(['Kothari Sweets']);
    expect(await partners.partnerOverview(deps, billingStaff, { accountId })).toMatchObject({ account: { name: 'Deccan Displays' } });
  });
});

describe('wholesale billing', () => {
  it('the reseller pays WallX; its paid customers follow its paid period', async () => {
    const { orgId } = await newCustomer({ apps: [{ appId: 'weather', quantity: 3 }] });
    // Nothing paid yet: billing cannot start.
    await expectCode(partners.startPartnerBilling(deps, ravi, { accountId, orgId }), 'failed-precondition');

    const { paidThrough } = await accounts.recordAccountPayment(deps, billingStaff, {
      accountId,
      amountMinor: 3 * 23_920 + 3 * 3_920,
      method: 'bank_transfer',
      reference: 'NEFT-1',
      paidAt: deps.now(),
      months: 1,
    });
    expect((await db.doc(paths.account(accountId)).get()).data()).toMatchObject({ paidThrough });
    expect((await sub(orgId)).status).toBe('trialing'); // trials are not billed

    await partners.startPartnerBilling(deps, ravi, { accountId, orgId });
    expect(await sub(orgId)).toMatchObject({ status: 'active', trialEndsAt: null, currentPeriodEnd: paidThrough });

    // App pricing, dealer prices 20 % off: Screen ₹299 → ₹239.20; Weather ₹49 → ₹39.20 (on 3 screens).
    let overview = await partners.partnerOverview(deps, ravi, { accountId });
    expect(overview.customers[0]).toMatchObject({ pricing: 'apps', dealerPriceMinor: 23_920, monthlyMinor: 3 * 23_920 + 3 * 3_920, trialing: false, resellerBilled: true });
    expect(overview.customers[0]!.lines.map((l) => [l.name, l.quantity, l.unitPriceMinor])).toEqual([['Screen', 3, 23_920], ['Weather & air quality', 3, 3_920]]);
    expect(overview.monthlyTotalMinor).toBe(3 * 23_920 + 3 * 3_920);
    expect(overview.apps.find((a) => a.id === 'weather')).toMatchObject({ listPriceMinor: 4_900, dealerPriceMinor: 3_920 });
    expect(overview.account).toMatchObject({ billingStatus: 'active' });

    // A fixed dealer price (kept with the staff-only costs) wins over the discount.
    await db.doc(paths.appCost('weather')).set({ dealerPriceMinor: 3_000 }, { merge: true });
    overview = await partners.partnerOverview(deps, ravi, { accountId });
    expect(overview.apps.find((a) => a.id === 'weather')).toMatchObject({ dealerPriceMinor: 3_000 });
    expect(overview.customers[0]!.lines.find((l) => l.name === 'Weather & air quality')).toMatchObject({ unitPriceMinor: 3_000 });
    await db.doc(paths.appCost('weather')).set({ dealerPriceMinor: null }, { merge: true });

    // The reseller changes plan and screens; the customer's limits follow.
    await partners.setPartnerSubscription(deps, ravi, { accountId, orgId, planId: 'starter', quantity: 5, apps: [] });
    expect(((await db.doc(paths.orgEntitlements(orgId)).get()).data() as EntitlementsDoc).limits.screens).toBe(5);
    overview = await partners.partnerOverview(deps, ravi, { accountId });
    expect(overview.monthlyTotalMinor).toBe(5 * 23_920);

    // WallX records payments on the reseller, never on the customer.
    await expectCode(billing.recordPayment(deps, billingStaff, { orgId, amountMinor: 100, method: 'upi', reference: 'x', paidAt: deps.now(), periods: 1 }), 'failed-precondition');

    // Unpaid: past due, then restricted after the grace period, like any organization.
    advance(32 * DAY);
    await runMonitor(deps);
    expect((await sub(orgId)).status).toBe('past_due');
    advance(8 * DAY);
    await runMonitor(deps);
    expect((await sub(orgId)).status).toBe('restricted');
    expect((await org(orgId)).billing?.restricted).toBe(true);

    // The next payment brings every paid customer back.
    const second = await accounts.recordAccountPayment(deps, billingStaff, { accountId, amountMinor: 5 * 23_920, method: 'upi', reference: 'UTR-2', paidAt: deps.now(), months: 1 });
    expect(second.customersUpdated).toBe(1);
    expect(await sub(orgId)).toMatchObject({ status: 'active', currentPeriodEnd: second.paidThrough });
  });

  it('staff move an existing organization to a reseller, billed wholesale or directly', async () => {
    const alice = user('alice');
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
    await accounts.setAccountPaidThrough(deps, billingStaff, { accountId, paidThrough: deps.now() + 30 * DAY, reason: 'Opening balance' });

    await accounts.setOrgAccount(deps, superadmin, { orgId: r.orgId, accountId, resellerBilled: false, reason: 'Signed through partner' });
    expect((await sub(r.orgId)).billedTo ?? null).toBeNull();
    expect(await member(r.orgId, 'ravi')).toMatchObject({ partner: { accountId } });

    await accounts.setOrgAccount(deps, superadmin, { orgId: r.orgId, accountId, resellerBilled: true, reason: 'Reseller pays now' });
    expect((await sub(r.orgId)).billedTo).toBe(accountId);

    await accounts.setOrgAccount(deps, superadmin, { orgId: r.orgId, accountId: null, reason: 'Back to direct' });
    expect((await sub(r.orgId)).billedTo ?? null).toBeNull();
    expect(await member(r.orgId, 'ravi')).toBeUndefined();
    expect(await member(r.orgId, 'alice')).toMatchObject({ role: 'owner' });
  });
});
