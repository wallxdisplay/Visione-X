import { logger } from 'firebase-functions/v2';
import { billingState, normalizeSubscription, paths, type SubscriptionDoc } from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import type { Deps } from '../lib/context';
import { notify } from '../lib/notify';
import { dueScheduledChange, notifyStatusChange, trialEntitlements, writeSubscription } from './billing';
import { entitlementsForSub } from '../lib/entitlements';
import { syncAndRepublish } from '../screens/screenApps';

/**
 * Billing part of the periodic monitor: subscriptions whose `nextTransitionAt` has passed get
 * their status re-derived (trial ended, period ended, grace over) and reminders sent
 * (trial ending in 3 days, renewal due in 7 days). Each status change is audited.
 */
export async function runBillingMonitor(deps: Deps): Promise<{ transitions: number; reminders: number }> {
  const { db, now } = deps;
  const at = now();
  const due = await db.collectionGroup('billing').where('nextTransitionAt', '<=', at).limit(200).get();
  let transitions = 0;
  let reminders = 0;
  for (const doc of due.docs) {
    if (doc.id !== 'subscription') continue;
    const orgId = doc.ref.parent.parent!.id;
    try {
      await auditedTransaction(db, [orgId], async (tx, audit) => {
        const raw = (await tx.get(db.doc(paths.orgSubscription(orgId)))).data() as SubscriptionDoc | undefined;
        if (!raw) return;
        const original = normalizeSubscription(raw);
        // App store: reductions scheduled for the end of the paid period apply now.
        const applied = await dueScheduledChange(tx, db, original, at);
        const sub = applied ?? original;
        const state = billingState(sub, at);
        // App pricing: every app is free in the trial; when it ends only the apps bought remain.
        const entitlements = applied
          ? await entitlementsForSub(tx, db, orgId, { ...sub, status: state.status }, at)
          : await trialEntitlements(tx, db, orgId, sub, sub, at);
        const next = writeSubscription(tx, db, orgId, { ...sub, reminders: state.reminder ? [...sub.reminders, state.reminder.key] : sub.reminders }, at);
        if (applied) {
          audit(orgId, {
            at,
            actorType: 'system',
            actorId: 'billing-monitor',
            orgId,
            action: 'billing.apps.scheduledApplied',
            target: { type: 'subscription', id: orgId },
            data: { change: original.scheduledChange, quantity: sub.quantity, apps: sub.apps },
          });
        }
        if (entitlements) tx.set(db.doc(paths.orgEntitlements(orgId)), entitlements);
        // Customers of a reseller are not reminded of renewals: the reseller pays (and is told in the portal).
        if (state.reminder && !(state.reminder.kind === 'due_soon' && sub.billedTo)) {
          reminders++;
          const until = state.reminder.kind === 'trial_ending' ? sub.trialEndsAt! : sub.currentPeriodEnd!;
          notify(tx, db, orgId, state.reminder.kind === 'trial_ending' ? 'billing_trial_ending' : 'billing_due_soon', { until }, '/billing', at);
        }
        if (next.status !== sub.status) {
          transitions++;
          notifyStatusChange(tx, db, orgId, sub.status, next.status, at);
          audit(orgId, {
            at,
            actorType: 'system',
            actorId: 'billing-monitor',
            orgId,
            action: 'billing.status.changed',
            target: { type: 'subscription', id: orgId },
            data: { from: sub.status, to: next.status },
          });
        }
      });
      // App pricing: when the trial ends, screens keep only the apps they hold.
      await syncAndRepublish(deps, orgId);
    } catch (err) {
      logger.error('Billing transition failed', { orgId, err: String(err) });
    }
  }
  return { transitions, reminders };
}
