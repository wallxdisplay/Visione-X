/**
 * Online payments (App store phase 5): customers billed by WallX pay with Razorpay Checkout.
 * A "Pay now" order covers the next period(s) — plus any App store charges waiting — or only
 * those charges. GST is added on top of the app's prices (CGST + SGST when the customer is in
 * WallX's state, IGST otherwise); tax invoices still come from the separate invoicing app.
 *
 * - orgs/{orgId}/paymentOrders/{razorpayOrderId}: what an order covers and whether it was paid.
 *   Readable with billing.view; written by Functions only.
 * - platform/settings.payments: the switch, WallX's state code, the GST rate, and the paid plan
 *   an organization moves to when it pays online at the end of its trial.
 */
import { z } from 'zod';

export const ONLINE_PAYMENT_KINDS = ['renewal', 'charges'] as const;
export type OnlinePaymentKind = (typeof ONLINE_PAYMENT_KINDS)[number];

export interface GstSplit {
  rateBps: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
}

export interface PaymentOrderDoc {
  /** Razorpay order id. */
  id: string;
  orgId: string;
  gateway: 'razorpay';
  kind: OnlinePaymentKind;
  /** Billing periods paid for (renewal). */
  periods: number;
  /** Price before GST, in paise. */
  taxableMinor: number;
  gst: GstSplit;
  /** What the customer pays (price + GST), in paise. */
  amountMinor: number;
  /** App store charges included, by their time. */
  chargeAts: number[];
  status: 'created' | 'paid' | 'failed';
  createdBy: string;
  createdAt: number;
  paidAt: number | null;
  /** Razorpay payment id once paid. */
  gatewayPaymentId: string | null;
  /** orgs/{orgId}/payments/{id} recorded for it. */
  paymentId: string | null;
}

export interface OnlinePaymentSettings {
  enabled: boolean;
  /** WallX's GST state code (two digits, e.g. "27" for Maharashtra). */
  supplierStateCode: string;
  gstRateBps: number;
  /** Paid plan for organizations still on the trial plan when they pay online (null = staff decide). */
  trialPlanTo: string | null;
}

export const DEFAULT_GST_RATE_BPS = 1800;

export const UpdatePaymentSettingsInput = z.object({
  enabled: z.boolean(),
  supplierStateCode: z.string().regex(/^\d{2}$/, 'Enter the two-digit GST state code'),
  gstRateBps: z.number().int().min(0).max(5_000),
  trialPlanTo: z.string().min(1).max(64).nullable(),
});

const orgId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** Quote (create: false) or create a Razorpay order (create: true). */
export const CreatePaymentOrderInput = z.object({
  orgId,
  kind: z.enum(ONLINE_PAYMENT_KINDS),
  periods: z.number().int().min(1).max(12),
  create: z.boolean(),
});

/** Checkout's success callback: verified on the server before anything is recorded. */
export const ConfirmPaymentInput = z.object({
  orgId,
  orderId: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/),
  paymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});

export interface PaymentQuote {
  kind: OnlinePaymentKind;
  periods: number;
  /** Price per period for the period(s) paid (renewal). */
  periodMinor: number | null;
  chargesMinor: number;
  taxableMinor: number;
  gst: GstSplit;
  amountMinor: number;
  /** The paid period after this payment (renewal). */
  periodStart: number | null;
  periodEnd: number | null;
  /** Set when the order was created: what Checkout needs. */
  order?: { id: string; keyId: string; currency: 'INR'; email: string | null; name: string; description: string };
}
