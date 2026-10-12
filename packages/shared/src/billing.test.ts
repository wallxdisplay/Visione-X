import { describe, expect, it } from 'vitest';
import { BILLING_GRACE_DAYS, RecordPaymentInput, ResolveBillingRequestInput, addMonths, billingState, paymentPeriod } from './billing';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 1, 6, 30);
const base = { trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, reminders: [] as string[] };

describe('addMonths', () => {
  it('adds calendar months and clamps the day', () => {
    expect(new Date(addMonths(Date.UTC(2026, 0, 31), 1)).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(new Date(addMonths(Date.UTC(2028, 0, 31), 1)).toISOString().slice(0, 10)).toBe('2028-02-29');
    expect(new Date(addMonths(Date.UTC(2026, 9, 15), 12)).toISOString().slice(0, 10)).toBe('2027-10-15');
  });
});

describe('billingState', () => {
  it('trial → reminder 3 days ahead → restricted when it ends unpaid', () => {
    const sub = { ...base, trialEndsAt: t0 + 14 * DAY };
    expect(billingState(sub, t0)).toEqual({ status: 'trialing', nextTransitionAt: t0 + 11 * DAY, reminder: null });
    const reminded = billingState(sub, t0 + 11 * DAY);
    expect(reminded.reminder).toEqual({ kind: 'trial_ending', key: `trial:${t0 + 14 * DAY}` });
    expect(reminded.nextTransitionAt).toBe(t0 + 14 * DAY);
    expect(billingState({ ...sub, reminders: [reminded.reminder!.key] }, t0 + 12 * DAY).reminder).toBeNull();
    expect(billingState(sub, t0 + 14 * DAY)).toMatchObject({ status: 'restricted', nextTransitionAt: null });
  });

  it('active → due-soon reminder → past due (grace) → restricted', () => {
    const end = t0 + 30 * DAY;
    const sub = { ...base, currentPeriodEnd: end };
    expect(billingState(sub, t0)).toMatchObject({ status: 'active', nextTransitionAt: end - 7 * DAY });
    expect(billingState(sub, end - 7 * DAY).reminder?.kind).toBe('due_soon');
    expect(billingState(sub, end)).toMatchObject({ status: 'past_due', nextTransitionAt: end + BILLING_GRACE_DAYS * DAY });
    expect(billingState(sub, end + BILLING_GRACE_DAYS * DAY).status).toBe('restricted');
  });

  it('a paid period wins over a running trial; cancelled ends without grace', () => {
    expect(billingState({ ...base, trialEndsAt: t0 + 10 * DAY, currentPeriodEnd: t0 + 30 * DAY }, t0).status).toBe('active');
    const cancelled = { ...base, currentPeriodEnd: t0 + DAY, cancelAtPeriodEnd: true };
    expect(billingState(cancelled, t0)).toMatchObject({ status: 'active', reminder: null, nextTransitionAt: t0 + DAY });
    expect(billingState(cancelled, t0 + DAY).status).toBe('cancelled');
  });
});

describe('paymentPeriod', () => {
  it('extends a running or grace-period subscription from its end', () => {
    const end = Date.UTC(2026, 9, 10);
    expect(paymentPeriod({ currentPeriodEnd: end, interval: 'monthly' }, 1, end - DAY)).toEqual({ start: end, end: Date.UTC(2026, 10, 10) });
    expect(paymentPeriod({ currentPeriodEnd: end, interval: 'annual' }, 1, end + 3 * DAY).start).toBe(end);
  });

  it('starts now after a lapse or for a first payment', () => {
    const now = Date.UTC(2026, 9, 20);
    expect(paymentPeriod({ currentPeriodEnd: Date.UTC(2026, 8, 1), interval: 'monthly' }, 2, now)).toEqual({ start: now, end: Date.UTC(2026, 11, 20) });
    expect(paymentPeriod({ currentPeriodEnd: null, interval: 'monthly' }, 1, now).start).toBe(now);
  });
});

describe('inputs', () => {
  it('requires a reference and a positive amount; declines need a reason', () => {
    const p = { orgId: 'o', amountMinor: 29_900, method: 'upi', reference: 'UTR123', paidAt: t0, periods: 1 };
    expect(RecordPaymentInput.safeParse(p).success).toBe(true);
    expect(RecordPaymentInput.safeParse({ ...p, amountMinor: 0 }).success).toBe(false);
    expect(RecordPaymentInput.safeParse({ ...p, reference: ' ' }).success).toBe(false);
    expect(ResolveBillingRequestInput.safeParse({ orgId: 'o', requestId: 'r', status: 'declined' }).success).toBe(false);
    expect(ResolveBillingRequestInput.safeParse({ orgId: 'o', requestId: 'r', status: 'done' }).success).toBe(true);
  });
});
