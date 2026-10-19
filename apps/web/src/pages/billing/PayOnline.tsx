import { Alert, Button, Dialog, SelectField, Spinner } from '@wallx-play/ui';
import { formatInr, type OnlinePaymentKind, type PaymentQuote, type SubscriptionDoc } from '@wallx-play/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

interface CheckoutResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}
interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', handler: (e: { error?: { description?: string } }) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

/** Loads Razorpay Checkout once, when the customer first pays. */
function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CHECKOUT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('checkout'));
    document.head.appendChild(s);
  });
}

/**
 * Pay the next period(s) — with any App store charges — or only the charges, with Razorpay.
 * The dialog closes when Checkout opens (a modal dialog would stay on top of it); the result is
 * reported to the page through onPaid / onFailed.
 */
export function PayOnlineDialog({
  orgId,
  sub,
  onClose,
  onCheckoutOpened,
  onPaid,
  onFailed,
}: {
  orgId: string;
  sub: SubscriptionDoc;
  onClose: () => void;
  onCheckoutOpened: () => void;
  onPaid: (text: string) => void;
  onFailed: (text: string) => void;
}) {
  const { t } = useTranslation();
  const hasCharges = (sub.pendingCharges ?? []).length > 0;
  const [kind, setKind] = useState<OnlinePaymentKind>('renewal');
  const [periods, setPeriods] = useState(1);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const periodChoices = sub.interval === 'annual' ? [1, 2] : [1, 3, 6, 12];

  useEffect(() => {
    setQuote(null);
    setError(null);
    call<PaymentQuote>('createPaymentOrder', { orgId, kind, periods, create: false }).then(setQuote, (err) => setError(errorMessage(err)));
  }, [orgId, kind, periods]);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      await loadCheckout().catch(() => {
        throw new Error(t('payOnline.checkoutBlocked'));
      });
      const created = await call<PaymentQuote>('createPaymentOrder', { orgId, kind, periods, create: true });
      const o = created.order!;
      const rzp = new window.Razorpay!({
        key: o.keyId,
        order_id: o.id,
        amount: created.amountMinor,
        currency: o.currency,
        name: o.name,
        description: o.description,
        prefill: o.email ? { email: o.email } : {},
        notes: { orgId },
        handler: async (r: CheckoutResponse) => {
          try {
            const res = await call<{ periodEnd: number | null }>('confirmPayment', { orgId, orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature });
            onPaid(res.periodEnd ? t('payOnline.paidUntil', { amount: formatInr(created.amountMinor), date: formatDate(res.periodEnd) }) : t('payOnline.paid', { amount: formatInr(created.amountMinor) }));
          } catch (err) {
            // Money may have been taken: the webhook records it even if this check failed.
            onFailed(`${errorMessage(err)} ${t('payOnline.recordedLater')}`);
          }
        },
      });
      rzp.on('payment.failed', (e) => onFailed(e.error?.description ?? t('payOnline.failed')));
      onCheckoutOpened();
      rzp.open();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const g = quote?.gst;
  return (
    <Dialog
      open
      title={t('payOnline.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !quote} onClick={() => void pay()}>
            {quote ? t('payOnline.pay', { amount: formatInr(quote.amountMinor) }) : t('payOnline.payShort')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="wxp-form__row">
        {hasCharges ? (
          <SelectField
            label={t('payOnline.what')}
            options={[
              { value: 'renewal', label: t('payOnline.kinds.renewal') },
              { value: 'charges', label: t('payOnline.kinds.charges') },
            ]}
            value={kind}
            onChange={(e) => setKind(e.target.value as OnlinePaymentKind)}
          />
        ) : null}
        {kind === 'renewal' ? (
          <SelectField
            label={t('payOnline.periods')}
            options={periodChoices.map((n) => ({ value: String(n), label: t(`payOnline.periodsN.${sub.interval}`, { count: n }) }))}
            value={String(periods)}
            onChange={(e) => setPeriods(Number(e.target.value))}
          />
        ) : null}
      </div>
      {!quote && !error ? <Spinner label={t('common.loading')} /> : null}
      {quote && g ? (
        <dl className="wxp-dl">
          {quote.periodMinor !== null ? (
            <>
              <dt>{t('payOnline.subscription')}</dt>
              <dd className="wxp-tabular">
                {formatInr(quote.periodMinor)} × {quote.periods}
              </dd>
            </>
          ) : null}
          {quote.chargesMinor > 0 ? (
            <>
              <dt>{t('payOnline.charges')}</dt>
              <dd className="wxp-tabular">{formatInr(quote.chargesMinor)}</dd>
            </>
          ) : null}
          <dt>{t('payOnline.taxable')}</dt>
          <dd className="wxp-tabular">{formatInr(quote.taxableMinor)}</dd>
          {g.igstMinor > 0 ? (
            <>
              <dt>{t('payOnline.igst', { pct: g.rateBps / 100 })}</dt>
              <dd className="wxp-tabular">{formatInr(g.igstMinor)}</dd>
            </>
          ) : (
            <>
              <dt>{t('payOnline.cgst', { pct: g.rateBps / 200 })}</dt>
              <dd className="wxp-tabular">{formatInr(g.cgstMinor)}</dd>
              <dt>{t('payOnline.sgst', { pct: g.rateBps / 200 })}</dt>
              <dd className="wxp-tabular">{formatInr(g.sgstMinor)}</dd>
            </>
          )}
          <dt>
            <strong>{t('payOnline.total')}</strong>
          </dt>
          <dd className="wxp-tabular">
            <strong>{formatInr(quote.amountMinor)}</strong>
          </dd>
          {quote.periodEnd ? (
            <>
              <dt>{t('payOnline.paidThrough')}</dt>
              <dd>{formatDate(quote.periodEnd)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <p className="wxp-muted">{t('payOnline.note')}</p>
    </Dialog>
  );
}
