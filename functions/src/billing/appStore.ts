/**
 * App store, phase 4: owners change their screens and apps themselves (app pricing, billed by
 * WallX). In the trial, or with no paid period running, changes apply at once and cost nothing
 * extra. During a paid period, additions apply at once and their prorated price for the rest of
 * the period is added to the next payment (until online payment exists); reductions apply when
 * the period ends, without refunds. Resellers' customers change apps through their reseller.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  appReleaseStatus,
  lineProblems,
  paths,
  periodLeftBps,
  planAppChange,
  stateAfter,
  type AppState,
  type ChangeAppsInput,
  type FeatureKey,
  type ReleaseStatus,
  type ChangeAppsResult,
  type PendingCharge,
  type SubscriptionDoc,
} from '@wallx-play/shared';
import { userAudit } from '../content/media';
import { auditedTransaction } from '../lib/audit';
import { requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { entitlementsForSub } from '../lib/entitlements';
import { notify } from '../lib/notify';
import { afterSeats, checkLines, priceLines, readAppCatalog, readPlan, readSubscription, subscriptionAmount, writeSubscription } from './billing';

export async function changeApps(deps: Deps, actor: Actor, input: z.infer<typeof ChangeAppsInput>): Promise<ChangeAppsResult> {
  const { db, now } = deps;
  const at = now();
  const work = auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'billing.manage');
    const sub = await readSubscription(tx, db, input.orgId);
    if (sub.billedTo) {
      const account = (await tx.get(db.doc(paths.account(sub.billedTo)))).data() as { name?: string } | undefined;
      throw new HttpsError('failed-precondition', `Your apps are provided by ${account?.name ?? 'your reseller'}. Contact them for changes.`);
    }
    if (sub.pricing !== 'apps') throw new HttpsError('failed-precondition', 'Your plan includes its features on every screen. Ask WallX to move you to app pricing to choose apps.');
    const plan = await readPlan(tx, db, sub.planId);
    const catalog = await readAppCatalog(tx, db);
    const features = ((await tx.get(db.doc(paths.featureCatalog()))).data() as { features?: Partial<Record<FeatureKey, ReleaseStatus>> } | undefined)?.features ?? {};
    const authorized = (await tx.get(db.collection(paths.screens(input.orgId)).where('status', '==', 'authorized').count())).data().count;

    const trialing = sub.status === 'trialing' && sub.currentPeriodEnd === null;
    const left = trialing ? 0 : periodLeftBps(sub.currentPeriodStart, sub.currentPeriodEnd, at);
    const running = left > 0;
    const current: AppState = { screens: sub.quantity, lines: (sub.apps ?? []).map((l) => ({ appId: l.appId, quantity: l.quantity })) };
    const wanted: AppState = { screens: input.screens, lines: input.apps.filter((l) => l.quantity > 0) };
    const plan2 = planAppChange(current, wanted, !running);

    // What may be added: apps on sale and released (not "coming soon").
    for (const inc of plan2.increases) {
      if (inc.item === 'screens') continue;
      const app = catalog.find((a) => a.id === inc.item);
      if (!app || app.base) throw new HttpsError('invalid-argument', `App “${inc.item}” cannot be bought.`);
      if (!app.active) throw new HttpsError('failed-precondition', `${app.name} is not sold any more.`);
      if (appReleaseStatus(app, features) === 'planned') throw new HttpsError('failed-precondition', `${app.name} is coming soon.`);
    }
    const fixedScreens = plan.limits.screens ?? null;
    // In the trial the customer chooses what to buy; the trial's own screen limit still applies.
    if (!trialing && fixedScreens !== null && wanted.screens > fixedScreens) {
      throw new HttpsError('failed-precondition', `Your plan allows ${fixedScreens} screens. Ask WallX about a larger plan.`);
    }
    if (authorized > wanted.screens) {
      throw new HttpsError('failed-precondition', `You have ${authorized} authorized screens. Remove screens before buying fewer.`);
    }
    // The state after any reductions must fit (screens, dependencies, sensor devices in use)…
    const owned = (sub.apps ?? []).map((l) => l.appId);
    await checkLines(tx, db, input.orgId, priceLines(wanted.lines, sub.apps ?? [], catalog, at), catalog, wanted.screens, owned);
    // …and so must the state until then.
    const nowLines = priceLines(plan2.now.lines, sub.apps ?? [], catalog, at);
    const nowProblems = lineProblems(nowLines, catalog, plan2.now.screens, owned);
    if (nowProblems.length) throw new HttpsError('invalid-argument', nowProblems[0]!);

    const draft: SubscriptionDoc = {
      ...sub,
      quantity: plan2.now.screens,
      apps: nowLines,
      scheduledChange: plan2.later ? { ...plan2.later, effectiveAt: sub.currentPeriodEnd!, requestedBy: actor.uid, requestedAt: at } : null,
      updatedAt: at,
      updatedBy: actor.uid,
    };
    const later = stateAfter(plan2.now, draft.scheduledChange);
    const laterSub: SubscriptionDoc = { ...draft, quantity: later.screens, apps: priceLines(later.lines, nowLines, catalog, at) };
    const beforeMinor = subscriptionAmount(plan, sub, catalog);
    const nowMinor = subscriptionAmount(plan, draft, catalog);
    const laterMinor = subscriptionAmount(plan, laterSub, catalog);
    const chargeMinor = running && beforeMinor !== null && nowMinor !== null && nowMinor > beforeMinor ? Math.round(((nowMinor - beforeMinor) * left) / 10_000) : 0;
    const result: ChangeAppsResult = {
      applied: false,
      increases: plan2.increases,
      decreases: plan2.decreases,
      beforeMinor,
      nowMinor,
      laterMinor,
      chargeMinor,
      periodLeftBps: left,
      effectiveAt: draft.scheduledChange?.effectiveAt ?? null,
      trialing,
    };
    if (!input.apply) return result;
    const unchanged = plan2.increases.length === 0 && JSON.stringify(draft.scheduledChange ? [draft.scheduledChange.screens, draft.scheduledChange.apps] : null) === JSON.stringify(sub.scheduledChange ? [sub.scheduledChange.screens, sub.scheduledChange.apps] : null);
    if (unchanged && !(plan2.decreases.length && !running)) throw new HttpsError('failed-precondition', 'Nothing to change.');

    // In the trial the price stays "free" until the first payment.
    draft.amountPerPeriodMinor = trialing ? sub.amountPerPeriodMinor : nowMinor;
    if (chargeMinor > 0) {
      const charge: PendingCharge = { at, amountMinor: chargeMinor, items: plan2.increases, periodLeftBps: left, by: actor.uid };
      draft.pendingCharges = [...(sub.pendingCharges ?? []), charge];
    }
    const entitlements = await entitlementsForSub(tx, db, input.orgId, draft, at);
    writeSubscription(tx, db, input.orgId, draft, at);
    tx.set(db.doc(paths.orgEntitlements(input.orgId)), entitlements);
    notify(tx, db, input.orgId, 'billing_apps_changed', { charge: chargeMinor, ...(result.effectiveAt ? { from: result.effectiveAt } : {}) }, '/apps', at);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'billing.apps.changed',
      target: { type: 'subscription', id: input.orgId },
      data: { increases: plan2.increases, decreases: plan2.decreases, chargeMinor, effectiveAt: result.effectiveAt },
    });
    return { ...result, applied: true };
  });
  // Seats on screens follow at once (additions now; reductions only when they apply).
  return input.apply ? afterSeats(deps, input.orgId, work) : work;
}
