/**
 * Plans, feature release status and per-org entitlement overrides (Super Admin). Prices,
 * limits and features are data: changing them recomputes the entitlements of every affected
 * organization, which is what Rules and Functions enforce.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import type { Query } from 'firebase-admin/firestore';
import type { z } from 'zod';
import {
  PLATFORM_AUDIT_CHAIN,
  normalizeSubscription,
  paths,
  type EntitlementOverridesDoc,
  type Plan,
  type SavePlanInput,
  type SetEntitlementOverridesInput,
  type SetFeatureReleaseInput,
  type SubscriptionDoc,
} from '@visione-x/shared';
import { auditedTransaction } from '../lib/audit';
import { getOrg, requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { computeEntitlements } from '../lib/entitlements';
import { platformAudit } from './billing';

/** Recomputes entitlements for every org (or only those on `planId`). Returns how many. */
export async function recomputeEntitlements({ db, now }: Deps, planId?: string): Promise<number> {
  let query: Query = db.collectionGroup('billing');
  if (planId) query = query.where('planId', '==', planId);
  const subs = (await query.get()).docs.filter((d) => d.id === 'subscription');
  let done = 0;
  for (const doc of subs) {
    const orgId = doc.ref.parent.parent!.id;
    try {
      await db.runTransaction(async (tx) => {
        const raw = (await tx.get(doc.ref)).data() as SubscriptionDoc | undefined;
        if (!raw) return;
        const sub = normalizeSubscription(raw);
        tx.set(db.doc(paths.orgEntitlements(orgId)), await computeEntitlements(tx, db, orgId, sub.planId, now(), sub.quantity));
      });
      done++;
    } catch (err) {
      logger.error('Entitlement recompute failed', { orgId, err: String(err) });
    }
  }
  return done;
}

export async function savePlan(deps: Deps, actor: Actor, input: z.infer<typeof SavePlanInput>): Promise<{ orgsUpdated: number }> {
  requirePlatform(actor, 'plan.manage');
  const { db, now } = deps;
  const at = now();
  const ref = db.doc(paths.plan(input.id));
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const existing = (await tx.get(ref)).data() as Plan | undefined;
    if (input.isNew && existing) throw new HttpsError('already-exists', `A plan with id “${input.id}” already exists.`);
    if (!input.isNew && !existing) throw new HttpsError('not-found', 'Plan not found.');
    if (input.tier === 'trial' && input.trialDays === 0) throw new HttpsError('invalid-argument', 'A trial plan needs at least one trial day.');
    const plan: Plan = {
      id: input.id,
      name: input.name,
      tier: input.tier,
      currency: 'INR',
      pricePerScreenMonthlyMinor: input.pricePerScreenMonthlyMinor,
      annualDiscountBps: input.annualDiscountBps,
      trialDays: input.trialDays,
      limits: input.limits,
      featureKeys: [...new Set(input.featureKeys)].sort(),
      active: input.active,
      version: (existing?.version ?? 0) + 1,
    };
    tx.set(ref, plan);
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: input.isNew ? 'plan.created' : 'plan.updated',
      target: { type: 'plan', id: input.id },
      reason: input.reason,
      data: existing
        ? { from: { price: existing.pricePerScreenMonthlyMinor, limits: existing.limits, features: existing.featureKeys, active: existing.active }, to: { price: plan.pricePerScreenMonthlyMinor, limits: plan.limits, features: plan.featureKeys, active: plan.active } }
        : { price: plan.pricePerScreenMonthlyMinor },
    });
  });
  return { orgsUpdated: input.isNew ? 0 : await recomputeEntitlements(deps, input.id) };
}

export async function setFeatureRelease(deps: Deps, actor: Actor, input: z.infer<typeof SetFeatureReleaseInput>): Promise<{ orgsUpdated: number }> {
  requirePlatform(actor, 'plan.manage');
  const { db, now } = deps;
  const at = now();
  const ref = db.doc(paths.featureCatalog());
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const catalog = ((await tx.get(ref)).data() as { features?: Record<string, string> } | undefined)?.features ?? {};
    const from = catalog[input.key] ?? 'planned';
    if (from === input.releaseStatus) throw new HttpsError('failed-precondition', `“${input.key}” is already ${from}.`);
    tx.set(ref, { features: { ...catalog, [input.key]: input.releaseStatus } }, { merge: true });
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: 'feature.release.changed',
      target: { type: 'feature', id: input.key },
      reason: input.reason,
      data: { from, to: input.releaseStatus },
    });
  });
  return { orgsUpdated: await recomputeEntitlements(deps) };
}

export async function setEntitlementOverrides({ db, now }: Deps, actor: Actor, input: z.infer<typeof SetEntitlementOverridesInput>): Promise<void> {
  requirePlatform(actor, 'org.limits.edit');
  const at = now();
  const overlap = input.grant.filter((k) => input.revoke.includes(k));
  if (overlap.length) throw new HttpsError('invalid-argument', `A feature cannot be granted and revoked: ${overlap.join(', ')}.`);
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await getOrg(tx, db, input.orgId);
    const subSnap = await tx.get(db.doc(paths.orgSubscription(input.orgId)));
    const sub = subSnap.data() as SubscriptionDoc | undefined;
    if (!sub) throw new HttpsError('failed-precondition', 'This organization has no subscription yet.');
    const before = (await tx.get(db.doc(paths.orgEntitlementOverrides(input.orgId)))).data() as EntitlementOverridesDoc | undefined;
    const limits = Object.fromEntries(Object.entries(input.limits).filter(([, v]) => v !== undefined));
    const overrides: EntitlementOverridesDoc = { grant: [...new Set(input.grant)].sort(), revoke: [...new Set(input.revoke)].sort(), limits };
    tx.set(db.doc(paths.orgEntitlementOverrides(input.orgId)), overrides);
    audit(input.orgId, {
      at,
      ...platformAudit(actor),
      orgId: input.orgId,
      action: 'entitlements.overrides.updated',
      target: { type: 'org', id: input.orgId },
      reason: input.reason,
      data: { from: before ?? null, to: overrides },
    });
  });
  // Recompute after the overrides are committed (a transaction cannot read its own writes).
  await db.runTransaction(async (tx) => {
    const sub = normalizeSubscription((await tx.get(db.doc(paths.orgSubscription(input.orgId)))).data() as SubscriptionDoc);
    tx.set(db.doc(paths.orgEntitlements(input.orgId)), await computeEntitlements(tx, db, input.orgId, sub.planId, at, sub.quantity));
  });
}
