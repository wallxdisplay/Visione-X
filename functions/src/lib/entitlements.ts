import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  paths,
  resolveAppFeatures,
  resolveEntitlements,
  type AppDoc,
  type AppLine,
  type SubscriptionDoc,
  type EntitlementOverridesDoc,
  type EntitlementsDoc,
  type FeatureKey,
  type Limits,
  type Plan,
  type ReleaseStatus,
} from '@wallx-play/shared';

interface CatalogDoc {
  features: Partial<Record<FeatureKey, ReleaseStatus>>;
}

/**
 * Reads plan, catalog and overrides (reads only — safe before transaction writes).
 * Plans without a fixed screen limit (paid plans) allow the number of screens purchased.
 */
export async function computeEntitlements(
  tx: Transaction,
  db: Firestore,
  orgId: string,
  planId: string,
  now: number,
  screensPurchased?: number,
  /** App pricing: the apps bought and whether the trial is running (else plan pricing). */
  apps?: { lines: AppLine[]; trialing: boolean },
): Promise<EntitlementsDoc> {
  const [planSnap, catalogSnap, overridesSnap, appsSnap] = await Promise.all([
    tx.get(db.doc(paths.plan(planId))),
    tx.get(db.doc(paths.featureCatalog())),
    tx.get(db.doc(paths.orgEntitlementOverrides(orgId))),
    apps ? tx.get(db.collection(paths.apps())) : Promise.resolve(null),
  ]);
  if (!planSnap.exists) {
    throw new HttpsError('failed-precondition', `Plan "${planId}" is not configured.`);
  }
  const plan = planSnap.data() as Plan;
  const catalog = (catalogSnap.data() as CatalogDoc | undefined)?.features ?? {};
  const overrides = overridesSnap.data() as EntitlementOverridesDoc | undefined;

  // App pricing: features come from the base app and the apps bought (all apps in the trial);
  // the plan is the base package (users, storage, retention…), plus extra storage and devices bought.
  const appCatalog = appsSnap ? appsSnap.docs.map((d) => d.data() as AppDoc) : [];
  // Without a base app (catalog not set up) the plan decides, as before.
  const fromApps = apps && appCatalog.some((a) => a.base) ? resolveAppFeatures({ catalog: appCatalog, lines: apps.lines, trialing: apps.trialing }) : null;
  const limits = plan.limits as Limits;
  const resolved = resolveEntitlements({
    planFeatures: fromApps ? fromApps.features : plan.featureKeys,
    planLimits: {
      ...limits,
      ...(plan.limits.screens === null && screensPurchased !== undefined ? { screens: screensPurchased } : {}),
      ...(fromApps && limits.storageGB !== null ? { storageGB: limits.storageGB + fromApps.storageGB } : {}),
      // Sensor devices bought; in the trial at least the plan's allowance (unlimited stays unlimited).
      ...(fromApps
        ? { sensorDevices: apps!.trialing ? (limits.sensorDevices === null ? null : Math.max(limits.sensorDevices, fromApps.sensorDevices)) : fromApps.sensorDevices }
        : {}),
    },
    catalog,
    ...(overrides ? { overrides } : {}),
  });
  // Seats per screen app, so members placing apps on screens see how many they have.
  const seats = fromApps && !apps!.trialing
    ? Object.fromEntries(apps!.lines.filter((l) => l.quantity > 0 && appCatalog.some((a) => a.id === l.appId && a.unit === 'screen' && !a.base)).map((l) => [l.appId, l.quantity]))
    : null;
  return { ...resolved, planId, computedAt: now, ...(seats ? { screenApps: seats } : {}) };
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

/** Entitlements for a subscription in either pricing mode (reads only — call before writes). */
export function entitlementsForSub(
  tx: Transaction,
  db: Firestore,
  orgId: string,
  sub: Pick<SubscriptionDoc, 'planId' | 'quantity' | 'pricing' | 'apps' | 'status'>,
  now: number,
): Promise<EntitlementsDoc> {
  const apps = sub.pricing === 'apps' ? { lines: sub.apps ?? [], trialing: sub.status === 'trialing' } : undefined;
  return computeEntitlements(tx, db, orgId, sub.planId, now, sub.quantity, apps);
}
