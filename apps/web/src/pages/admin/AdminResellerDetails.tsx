import { collection, orderBy, query } from 'firebase/firestore';
import { Alert, Button, Dialog, SelectField, Spinner, StatusChip, TextField } from '@wallx-play/ui';
import {
  PAYMENT_METHODS,
  formatInr,
  hasPlatformPermission,
  paths,
  type AccountDoc,
  type AccountPaymentDoc,
  type PartnerOverview,
  type PaymentMethod,
} from '@wallx-play/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { parseRupees } from '../../content/billing';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDate } from '../../lib/format';
import { useQueryData, type WithId } from '../../lib/hooks';
import { AccountTeam } from '../partner/PartnerTeam';
import { STATUS_TONE } from '../billing/Billing';
import { fromDateInput, toDateInput } from './OrgBilling';

const TONE = { active: 'success', past_due: 'warning', restricted: 'danger', none: 'neutral' } as const;

/** Super Admin → Resellers → one reseller: wholesale billing, customers and team. */
export function AccountDetailsDialog({ account, onClose }: { account: WithId<AccountDoc>; onClose: () => void }) {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const canBill = hasPlatformPermission(platformRole, 'billing.override');
  const [overview, setOverview] = useState<PartnerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [dating, setDating] = useState(false);
  const [voiding, setVoiding] = useState<AccountPaymentDoc | null>(null);
  const payments = useQueryData<AccountPaymentDoc>(`accountPayments:${account.id}`, () => query(collection(db, paths.accountPayments(account.id)), orderBy('paidAt', 'desc')));

  const load = useCallback(async () => {
    try {
      setOverview(await call<PartnerOverview>('partnerOverview', { accountId: account.id }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [account.id]);
  useEffect(() => void load(), [load]);

  const a = overview?.account;
  return (
    <Dialog open size="lg" title={account.name} onClose={onClose} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!overview || !a ? (
        <Spinner label={t('common.loading')} />
      ) : (
        <>
          <dl className="wxp-dl">
            <dt>{t('partner.billing.status')}</dt>
            <dd>
              <StatusChip tone={TONE[a.billingStatus]}>{t(`partner.billing.statuses.${a.billingStatus}`)}</StatusChip>
            </dd>
            <dt>{t('partner.billing.paidThrough')}</dt>
            <dd>{formatDate(a.paidThrough)}</dd>
            <dt>{t('partner.billing.monthly')}</dt>
            <dd className="wxp-tabular">{overview.monthlyTotalMinor === null ? t('partner.priceToAgree') : formatInr(overview.monthlyTotalMinor)}</dd>
            <dt>{t('adminResellers.portal')}</dt>
            <dd>{a.portal ? t('adminResellers.portalOn') : t('adminResellers.portalOff')}</dd>
          </dl>
          {canBill ? (
            <div className="wxp-toolbar">
              <Button variant="primary" size="sm" onClick={() => setPaying(true)}>
                {t('adminResellers.recordPayment')}
              </Button>
              <Button size="sm" onClick={() => setDating(true)}>
                {t('adminResellers.setPaidThrough')}
              </Button>
            </div>
          ) : null}

          <h3 className="section-title">{t('adminResellers.customers')}</h3>
          {overview.customers.length ? (
            <div className="wxp-table-wrap">
              <table className="wxp-table">
                <thead>
                  <tr>
                    <th>{t('partner.customers.name')}</th>
                    <th>{t('partner.customers.plan')}</th>
                    <th>{t('partner.customers.screensCol')}</th>
                    <th>{t('partner.customers.billing')}</th>
                    <th>{t('partner.customers.monthlyCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.customers.map((c) => (
                    <tr key={c.orgId}>
                      <td>{c.name}</td>
                      <td>{c.planName}</td>
                      <td className="wxp-tabular">
                        {c.screensUsed} / {c.quantity}
                      </td>
                      <td>
                        <StatusChip tone={STATUS_TONE[c.billing.status]}>{t(`billing.status.${c.billing.status}`)}</StatusChip>
                        <div className="wxp-muted">{c.resellerBilled ? (c.trialing ? t('partner.customers.trialUntil', { date: formatDate(c.billing.trialEndsAt) }) : t('adminResellers.wholesale')) : t('partner.customers.billedByWallx')}</div>
                      </td>
                      <td className="wxp-tabular">{!c.resellerBilled ? '—' : c.trialing ? t('partner.customers.free') : c.monthlyMinor === null ? t('partner.priceToAgree') : formatInr(c.monthlyMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="wxp-muted">{t('adminResellers.noOrgs')}</p>
          )}

          <h3 className="section-title">{t('partner.billing.payments')}</h3>
          {payments.data.length ? (
            <ul className="support-grants">
              {payments.data.map((p) => (
                <li key={p.id} className="support-grant">
                  <span>
                    <strong className="wxp-tabular">{formatInr(p.amountMinor)}</strong> · {formatDate(p.paidAt)} · {t(`billing.methods.${p.method}`)} · {p.reference}
                    <span className="wxp-muted">
                      {' '}
                      · {formatDate(p.periodStart)} – {formatDate(p.periodEnd)}
                    </span>
                    {p.voided ? <StatusChip tone="neutral">{t('billing.voided')}</StatusChip> : null}
                  </span>
                  {canBill && !p.voided ? (
                    <Button size="sm" variant="tertiary" onClick={() => setVoiding(p)}>
                      {t('adminBilling.void')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="wxp-muted">{t('partner.billing.noPayments')}</p>
          )}

          <AccountTeam accountId={account.id} manage={hasPlatformPermission(platformRole, 'account.manage')} />
        </>
      )}

      {paying ? (
        <PaymentDialog
          accountId={account.id}
          suggestedMinor={overview?.monthlyTotalMinor ?? null}
          onClose={() => setPaying(false)}
          onDone={async () => {
            setPaying(false);
            await load();
          }}
        />
      ) : null}
      {dating ? (
        <PaidThroughDialog
          accountId={account.id}
          current={a?.paidThrough ?? null}
          onClose={() => setDating(false)}
          onDone={async () => {
            setDating(false);
            await load();
          }}
        />
      ) : null}
      {voiding ? <VoidDialog accountId={account.id} payment={voiding} onClose={() => setVoiding(null)} /> : null}
    </Dialog>
  );
}

function PaymentDialog({ accountId, suggestedMinor, onClose, onDone }: { accountId: string; suggestedMinor: number | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(suggestedMinor ? (suggestedMinor / 100).toFixed(2) : '');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [invoice, setInvoice] = useState('');
  const [months, setMonths] = useState('1');
  const [paidOn, setPaidOn] = useState(toDateInput(Date.now()));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amountMinor = parseRupees(amount);
  const paidAt = fromDateInput(paidOn, false);
  const m = Number(months);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('recordAccountPayment', { accountId, amountMinor, method, reference, externalInvoiceNo: invoice || undefined, paidAt, months: m });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('adminResellers.recordPayment')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !amountMinor || !reference.trim() || !paidAt || !(m >= 1 && m <= 36)} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="wxp-form__row">
        <TextField label={t('billing.amount')} hint={t('adminResellers.amountHint')} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        <TextField label={t('adminResellers.months')} type="number" min={1} max={36} value={months} onChange={(e) => setMonths(e.target.value)} />
      </div>
      <div className="wxp-form__row">
        <SelectField label={t('billing.method')} options={PAYMENT_METHODS.filter((m) => m !== 'razorpay').map((x) => ({ value: x, label: t(`billing.methods.${x}`) }))} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} />
        <TextField label={t('billing.paidOn')} type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      </div>
      <div className="wxp-form__row">
        <TextField label={t('billing.reference')} required maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
        <TextField label={t('billing.invoiceNo')} maxLength={60} value={invoice} onChange={(e) => setInvoice(e.target.value)} />
      </div>
      <p className="wxp-muted">{t('adminResellers.paymentHelp')}</p>
    </Dialog>
  );
}

function PaidThroughDialog({ accountId, current, onClose, onDone }: { accountId: string; current: number | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [date, setDate] = useState(toDateInput(current));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('setAccountPaidThrough', { accountId, paidThrough: date ? fromDateInput(date, true) : null, reason });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('adminResellers.setPaidThrough')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || reason.trim().length < 5} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('partner.billing.paidThrough')} hint={t('adminResellers.paidThroughHint')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <TextField label={t('adminResellers.reason')} hint={t('adminResellers.reasonHint5')} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}

function VoidDialog({ accountId, payment, onClose }: { accountId: string; payment: AccountPaymentDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('voidAccountPayment', { accountId, paymentId: payment.id, reason });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={t('adminBilling.voidTitle')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={busy || reason.trim().length < 5} onClick={() => void save()}>
            {t('adminBilling.void')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p>{t('adminResellers.voidBody', { amount: formatInr(payment.amountMinor) })}</p>
      <TextField label={t('adminResellers.reason')} hint={t('adminResellers.reasonHint5')} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}
