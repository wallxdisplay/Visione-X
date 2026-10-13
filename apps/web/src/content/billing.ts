import { collection, collectionGroup, limit, orderBy, query, where } from 'firebase/firestore';
import {
  paths,
  type BillingRequestDoc,
  type FeatureKey,
  type PaymentDoc,
  type Plan,
  type ReleaseStatus,
  type SubscriptionDoc,
} from '@wallx-play/shared';
import { db } from '../lib/firebase';
import { useDoc, useQueryData } from '../lib/hooks';

export const useSubscription = (orgId: string | null) => useDoc<SubscriptionDoc>(orgId ? paths.orgSubscription(orgId) : null);

export const usePayments = (orgId: string | null) =>
  useQueryData<PaymentDoc>(orgId ? `payments:${orgId}` : null, () =>
    query(collection(db, paths.payments(orgId!)), orderBy('paidAt', 'desc'), limit(50)),
  );

export const useBillingRequests = (orgId: string | null) =>
  useQueryData<BillingRequestDoc>(orgId ? `billingRequests:${orgId}` : null, () =>
    query(collection(db, paths.billingRequests(orgId!)), orderBy('createdAt', 'desc'), limit(20)),
  );

/** Active plans (any signed-in user); platform staff see inactive ones too with `all`. */
export const usePlans = (all = false) =>
  useQueryData<Plan>(`plans:${all}`, () =>
    all ? query(collection(db, 'plans')) : query(collection(db, 'plans'), where('active', '==', true)),
  );

export const useFeatureCatalog = () => useDoc<{ features: Partial<Record<FeatureKey, ReleaseStatus>> }>(paths.featureCatalog());

/** Billing staff: every subscription (collection group "billing", doc id "subscription"). */
export const useAllSubscriptions = (enabled: boolean) =>
  useQueryData<SubscriptionDoc>(enabled ? 'allSubscriptions' : null, () => query(collectionGroup(db, 'billing'), limit(1000)));

/** orgs/{orgId}/… → orgId */
export const orgIdOf = (path: string) => path.split('/')[1] ?? '';

export const useOpenBillingRequests = (enabled: boolean) =>
  useQueryData<BillingRequestDoc>(enabled ? 'openBillingRequests' : null, () =>
    query(collectionGroup(db, 'billingRequests'), where('status', '==', 'open'), limit(200)),
  );

/** "1,234.50" → 123450 paise; null when empty or invalid. */
export function parseRupees(text: string): number | null {
  const clean = text.replace(/[,₹\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export const rupees = (minor: number | null | undefined) => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2));
