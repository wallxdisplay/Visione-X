import { logger } from 'firebase-functions/v2';
import { billingState, normalizeSubscription, paths, type SubscriptionDoc } from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import type { Deps } from '../lib/context';
import { notify } from '../lib/notify';
import { notifyStatusChange, writeSubscription } from './billing';

/**
 * Billing part of the periodic monitor: subscriptions whose `nextTransitionAt` has passed get
 * their status re-derived (trial ended, period ended, grace over) and reminders sent
 * (trial ending in 3 days, renewal due in 7 days). Each status change is audited.
 */
export async function runBillingMonitor({ db, now }: Deps): Promise<{ transitions: number; reminders: number }> {
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
        const sub = normalizeSubscription(raw);
        const state = billingState(sub, at);
        const next = writeSubscription(tx, db, orgId, { ...sub, reminders: state.reminder ? [...sub.reminders, state.reminder.key] : sub.reminders }, at);
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
    } catch (err) {
      logger.error('Billing transition failed', { orgId, err: String(err) });
    }
  }
  return { transitions, reminders };
}
