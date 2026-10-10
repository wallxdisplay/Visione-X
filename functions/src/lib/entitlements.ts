import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  paths,
  resolveEntitlements,
  type EntitlementOverridesDoc,
  type EntitlementsDoc,
  type FeatureKey,
  type Limits,
  type Plan,
  type ReleaseStatus,
} from '@visione-x/shared';

interface CatalogDoc {
  features: Partial<Record<FeatureKey, ReleaseStatus>>;
}

/** Reads plan, catalog and overrides (reads only — safe before transaction writes). */
export async function computeEntitlements(
  tx: Transaction,
  db: Firestore,
  orgId: string,
  planId: string,
  now: number,
): Promise<EntitlementsDoc> {
  const [planSnap, catalogSnap, overridesSnap] = await Promise.all([
    tx.get(db.doc(paths.plan(planId))),
    tx.get(db.doc(paths.featureCatalog())),
    tx.get(db.doc(paths.orgEntitlementOverrides(orgId))),
  ]);
  if (!planSnap.exists) {
    throw new HttpsError('failed-precondition', `Plan "${planId}" is not configured.`);
  }
  const plan = planSnap.data() as Plan;
  const catalog = (catalogSnap.data() as CatalogDoc | undefined)?.features ?? {};
  const overrides = overridesSnap.data() as EntitlementOverridesDoc | undefined;

  const resolved = resolveEntitlements({
    planFeatures: plan.featureKeys,
    planLimits: plan.limits as Limits,
    catalog,
    ...(overrides ? { overrides } : {}),
  });
  return { ...resolved, planId, computedAt: now };
}

export function requireFeature(entitlements: EntitlementsDoc, feature: FeatureKey, label: string): void {
  if (!entitlements.features.includes(feature)) {
    throw new HttpsError('permission-denied', `${label} is not included in your plan.`);
  }
}

export async function readEntitlements(
  tx: Transaction,
  db: Firestore,
  orgId: string,
): Promise<EntitlementsDoc> {
  const snap = await tx.get(db.doc(paths.orgEntitlements(orgId)));
  if (!snap.exists) {
    throw new HttpsError('failed-precondition', 'Organization entitlements are not set up yet.');
  }
  return snap.data() as EntitlementsDoc;
}
