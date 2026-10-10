/**
 * Gateway-agnostic billing contract. Razorpay is the first adapter; a "manual" adapter covers
 * bank transfers and admin invoices. Server-side only — never import into web or player code.
 */

export type GatewayId = 'razorpay' | 'manual';

export interface CustomerRef {
  orgId: string;
  name: string;
  email: string;
  gstin?: string;
}

export interface SubscriptionRequest {
  customer: CustomerRef;
  gatewayPlanId: string;
  /** Number of screens. */
  quantity: number;
  interval: 'monthly' | 'annual';
  /** Start charging after trial (epoch millis), if any. */
  startAt?: number;
}

export interface SubscriptionRef {
  gateway: GatewayId;
  gatewaySubscriptionId: string;
  /** Data the browser needs to open checkout. Contains no secrets. */
  checkout?: { keyId: string; subscriptionId: string };
}

export type BillingEventType =
  | 'subscription.activated'
  | 'subscription.charged'
  | 'subscription.halted'
  | 'subscription.cancelled'
  | 'subscription.updated'
  | 'payment.failed'
  | 'invoice.paid'
  | 'unknown';

export interface BillingEvent {
  /** Gateway event id; used for idempotency. */
  eventId: string;
  type: BillingEventType;
  gateway: GatewayId;
  gatewaySubscriptionId?: string;
  gatewayPaymentId?: string;
  amountMinor?: number;
  occurredAt: number;
  raw: unknown;
}

export interface PaymentGateway {
  readonly id: GatewayId;
  createSubscription(req: SubscriptionRequest): Promise<SubscriptionRef>;
  changeQuantity(gatewaySubscriptionId: string, quantity: number): Promise<void>;
  changePlan(gatewaySubscriptionId: string, gatewayPlanId: string, atPeriodEnd: boolean): Promise<void>;
  cancel(gatewaySubscriptionId: string, atPeriodEnd: boolean): Promise<void>;
  /** Must verify the signature against the raw request body before parsing. */
  verifyWebhook(rawBody: Buffer | string, signature: string): boolean;
  parseWebhook(rawBody: Buffer | string): BillingEvent;
}
