import { beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_AUDIT_CHAIN, paths, type AccountDoc, type OrgDoc } from '@wallx-play/shared';
import * as accounts from '../../functions/src/accounts/accounts';
import { verifyAuditChain } from '../../functions/src/lib/audit';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const billing = user('bill', { platformRole: 'billing' });
let orgId: string;
const org = async () => (await db.doc(paths.org(orgId)).get()).data() as OrgDoc;
const account = { name: 'Pune Signage Partners', contactName: 'Ravi', email: 'ravi@psp.in', phone: '+91 98220 11111', city: 'Pune', gstin: null, status: 'active' as const, notes: '' };

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, user('alice'), {
    orgName: 'Chai Point', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

describe('reseller accounts', () => {
  it('staff with account.manage create accounts and assign organizations (audited on both sides)', async () => {
    await expectCode(accounts.saveAccount(deps, user('sup', { platformRole: 'support' }), account), 'permission-denied');
    const { accountId } = await accounts.saveAccount(deps, billing, account);
    expect(((await db.doc(paths.account(accountId)).get()).data() as AccountDoc)).toMatchObject({ type: 'reseller', name: account.name, status: 'active' });

    await accounts.setOrgAccount(deps, billing, { orgId, accountId, reason: 'Signed through PSP' });
    expect((await org()).parentAccountId).toBe(accountId);
    const orgLog = await db.collection(paths.auditLogs()).where('chainId', '==', orgId).where('action', '==', 'org.account.changed').get();
    expect(orgLog.docs[0]?.data()).toMatchObject({ reason: 'Signed through PSP', data: { to: accountId } });
    expect((await verifyAuditChain(db, orgId)).ok).toBe(true);
    expect((await verifyAuditChain(db, PLATFORM_AUDIT_CHAIN)).ok).toBe(true);

    // Inactive accounts take no new organizations; organizations can go back to WallX direct.
    await accounts.saveAccount(deps, billing, { ...account, accountId, status: 'inactive' });
    await accounts.setOrgAccount(deps, billing, { orgId, accountId: null, reason: 'Contract ended' });
    expect((await org()).parentAccountId).toBeNull();
    await expectCode(accounts.setOrgAccount(deps, billing, { orgId, accountId, reason: 'Again' }), 'failed-precondition');
    await expectCode(accounts.setOrgAccount(deps, billing, { orgId, accountId: 'missing', reason: 'Typo' }), 'not-found');
  });
});
