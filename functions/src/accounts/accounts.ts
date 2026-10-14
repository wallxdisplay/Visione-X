/** Reseller / dealer accounts (groundwork, packages/shared/src/accounts.ts). */
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import { PLATFORM_AUDIT_CHAIN, paths, type AccountDoc, type OrgDoc, type SaveAccountInput, type SetOrgAccountInput } from '@wallx-play/shared';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { getOrg, requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';

export async function saveAccount({ db, now }: Deps, actor: Actor, input: z.infer<typeof SaveAccountInput>): Promise<{ accountId: string }> {
  requirePlatform(actor, 'account.manage');
  const ref = input.accountId ? db.doc(paths.account(input.accountId)) : db.collection(paths.accounts()).doc();
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const before = (await tx.get(ref)).data() as AccountDoc | undefined;
    if (input.accountId && !before) throw new HttpsError('not-found', 'Reseller account not found.');
    const at = now();
    const doc: AccountDoc = {
      id: ref.id,
      type: 'reseller',
      name: input.name,
      contactName: input.contactName ?? '',
      email: input.email ?? '',
      phone: input.phone ?? '',
      city: input.city ?? '',
      gstin: input.gstin ?? null,
      status: input.status ?? 'active',
      notes: input.notes ?? '',
      createdAt: before?.createdAt ?? at,
      createdBy: before?.createdBy ?? actor.uid,
      updatedAt: at,
      updatedBy: actor.uid,
    };
    tx.set(ref, doc);
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: before ? 'account.updated' : 'account.created',
      target: { type: 'account', id: ref.id },
      data: { name: doc.name, status: doc.status, ...(before ? { from: { name: before.name, status: before.status } } : {}) },
    });
  });
  return { accountId: ref.id };
}

/** Puts an organization under a reseller account, or back to WallX direct (accountId null). */
export async function setOrgAccount({ db, now }: Deps, actor: Actor, input: z.infer<typeof SetOrgAccountInput>): Promise<void> {
  requirePlatform(actor, 'account.manage');
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN, input.orgId], async (tx, audit) => {
    const org: OrgDoc = await getOrg(tx, db, input.orgId);
    let account: AccountDoc | undefined;
    if (input.accountId) {
      account = (await tx.get(db.doc(paths.account(input.accountId)))).data() as AccountDoc | undefined;
      if (!account) throw new HttpsError('not-found', 'Reseller account not found.');
      if (account.status !== 'active') throw new HttpsError('failed-precondition', `“${account.name}” is inactive.`);
    }
    if (org.parentAccountId === input.accountId) return;
    const at = now();
    tx.update(db.doc(paths.org(input.orgId)), { parentAccountId: input.accountId, updatedAt: at });
    const entry = {
      at,
      ...platformAudit(actor),
      orgId: input.orgId,
      action: 'org.account.changed',
      target: { type: 'org', id: input.orgId },
      reason: input.reason,
      data: { from: org.parentAccountId, to: input.accountId, account: account?.name ?? null },
    };
    // Recorded for WallX and in the organization's own log.
    audit(PLATFORM_AUDIT_CHAIN, entry);
    audit(input.orgId, entry);
  });
}
