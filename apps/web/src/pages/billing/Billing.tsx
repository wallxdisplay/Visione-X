import { Alert, Button, Dialog, EmptyState, PageHeader, SelectField, Spinner, StatusChip, TextAreaField, TextField } from '@wallx-play/ui';
import {
  BILLING_GRACE_DAYS,
  BILLING_REQUEST_KINDS,
  appsBasePriceMinor,
  billLines,
  formatInr,
  type BillingInterval,
  type BillingRequestKind,
  type BillingStatus,
} from '@wallx-play/shared';
import { CreditCard, Send, Wallet } from 'lucide-react';
import { PayOnlineDialog } from './PayOnline';
import { usePlatformSettings } from '../../lib/platformSettings';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useBillingRequests, usePayments, usePlans, useSubscription } from '../../content/billing';
import { BillLinesTable, useAppCatalog } from '../../content/apps';
import { useScreens } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';
import './billing.css';

const DAY = 86_400_000;

export const STATUS_TONE: Record<BillingStatus, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  trialing: 'info',
  past_due: 'warning',
  restricted: 'danger',
  cancelled: 'neutral',
};

/** Customer view of the subscription: plan, usage, paid period, payments and change requests. */
export function Billing() {
  const { t } = useTranslation();
  const { orgId, org, can, entitlements, siteScope } = useOrg();
  const view = can('billing.view');
  const sub = useSubscription(view ? orgId : null);
  const payments = usePayments(view ? orgId : null);
  const requests = useBillingRequests(view ? orgId : null);
  const plans = usePlans();
  const appCatalog = useAppCatalog(view);
  const allScreens = useScreens(orgId, siteScope);
  const screens = { ...allScreens, data: allScreens.data.filter((s) => s.status === 'authorized') };
  const [requesting, setRequesting] = useState(false);
  const [sent, setSent] = useState(false);
  const platform = usePlatformSettings();
  const [paying, setPaying] = useState(false);
  const [paidText, setPaidText] = useState<string | null>(null);

  if (!view) {
    return (
      <>
        <PageHeader title={t('nav.billing')} />
        <div className="wxp-card">
          <EmptyState icon={<CreditCard size={24} aria-hidden />} title={t('billing.noAccessTitle')} description={t('billing.noAccessBody')} />
        </div>
      </>
    );
  }
  if (sub.loading) return <Spinner label={t('common.loading')} />;
  const s = sub.data;
  if (!s) {
    return (
      <>
        <PageHeader title={t('nav.billing')} />
        <p className="wxp-muted">{t('billing.none')}</p>
      </>
    );
  }
  const plan = plans.data.find((p) => p.id === s.planId);
  const limit = entitlements?.limits.screens ?? s.quantity;
  // App pricing: the monthly bill as lines (base screens + apps).
  const lines =
    s.pricing === 'apps' && plan
      ? billLines({
          screens: s.quantity,
          basePriceMinor: appsBasePriceMinor(plan, appCatalog.data.find((a) => a.base), s.customPriceMinor),
          lines: s.apps ?? [],
          adjustmentMinor: s.adjustmentMinor ?? 0,
          catalog: appCatalog.data,
        })
      : null;
  // Wholesale: the reseller pays WallX and bills the customer itself.
  const reseller = s.billedTo ? (org?.partnerName ?? t('billing.yourReseller')) : null;

  return (
    <>
      <PageHeader
        title={t('nav.billing')}
        description={s.billedTo ? t('billing.descriptionReseller') : t('billing.description')}
        actions={
          can('billing.manage') && !s?.billedTo ? (
            <div className="wxp-toolbar" style={{ margin: 0 }}>
              {platform.data?.payments?.enabled ? (
                <Button variant="primary" onClick={() => setPaying(true)}>
                  <Wallet size={15} aria-hidden /> {t('payOnline.button')}
                </Button>
              ) : null}
              <Button variant={platform.data?.payments?.enabled ? 'secondary' : 'primary'} onClick={() => setRequesting(true)}>
                <Send size={15} aria-hidden /> {t('billing.requestChange')}
              </Button>
            </div>
          ) : null
        }
      />
      {sent ? <Alert tone="success">{t('billing.requestSent')}</Alert> : null}
      {paidText ? <Alert tone="success">{paidText}</Alert> : null}
      {reseller ? <Alert tone="info">{t('billing.viaReseller', { name: reseller })}</Alert> : null}

      <div className="billing-summary wxp-card">
        <div className="billing-summary__head">
          <h2>{plan?.name ?? s.planId}</h2>
          <StatusChip tone={STATUS_TONE[s.status]}>{t(`billing.status.${s.status}`)}</StatusChip>
        </div>
        <dl className="wxp-dl">
          <dt>{t('billing.screens')}</dt>
          <dd className="wxp-tabular">{t('billing.screensUsed', { used: screens.data.length, limit: limit ?? '∞' })}</dd>
          <dt>{t('billing.interval')}</dt>
          <dd>{t(`billing.intervals.${s.interval}`)}</dd>
          <dt>{t('billing.price')}</dt>
          <dd>
            {reseller ? (
              <span className="wxp-muted">{t('billing.priceViaReseller', { name: reseller })}</span>
            ) : s.amountPerPeriodMinor !== null ? (
              <>
                <strong>{formatInr(s.amountPerPeriodMinor)}</strong> {t(`billing.perInterval.${s.interval}`)}{' '}
                <span className="wxp-muted">{t('billing.plusGst')}</span>
              </>
            ) : (
              <span className="wxp-muted">{s.status === 'trialing' ? t('billing.freeTrial') : t('billing.customPrice')}</span>
            )}
          </dd>
          {s.status === 'trialing' && s.trialEndsAt ? (
            <>
              <dt>{t('billing.trialEnds')}</dt>
              <dd>{formatDate(s.trialEndsAt)}</dd>
            </>
          ) : null}
          {s.currentPeriodEnd ? (
            <>
              <dt>{s.cancelAtPeriodEnd ? t('billing.endsOn') : t('billing.paidThrough')}</dt>
              <dd>{formatDate(s.currentPeriodEnd)}</dd>
            </>
          ) : null}
          {s.status === 'past_due' && s.currentPeriodEnd ? (
            <>
              <dt>{t('billing.graceUntil')}</dt>
              <dd>{formatDate(s.currentPeriodEnd + BILLING_GRACE_DAYS * DAY)}</dd>
            </>
          ) : null}
        </dl>
        <p className="wxp-muted billing-summary__note">{t(`billing.statusHelp.${s.status}`)}</p>
      </div>

      {lines ? (
        <section className="billing-apps">
          <h2 className="section-title">{t('appBilling.yourApps')}</h2>
          {s.status === 'trialing' ? <Alert tone="info">{t('appBilling.trialAllApps', { date: formatDate(s.trialEndsAt) })}</Alert> : null}
          <BillLinesTable lines={lines} />
          <p className="wxp-muted">{t('appBilling.linesNote')}</p>
          {s.pendingCharges?.length ? (
            <Alert tone="info">{t('appStore.pending', { amount: formatInr(s.pendingCharges.reduce((sum, c) => sum + c.amountMinor, 0)) })}</Alert>
          ) : null}
          {s.scheduledChange ? <Alert tone="warning">{t('appStore.scheduledShort', { date: formatDate(s.scheduledChange.effectiveAt) })}</Alert> : null}
          {!reseller ? <Link to="/apps">{t('appStore.open')}</Link> : null}
        </section>
      ) : null}

      {reseller ? null : <h2 className="section-title">{t('billing.payments')}</h2>}
      {reseller ? null : payments.data.length === 0 && !payments.loading ? (
        <p className="wxp-muted">{t('billing.noPayments')}</p>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('billing.paidOn')}</th>
                <th>{t('billing.amount')}</th>
                <th>{t('billing.method')}</th>
                <th>{t('billing.reference')}</th>
                <th>{t('billing.invoiceNo')}</th>
                <th>{t('billing.covers')}</th>
              </tr>
            </thead>
            <tbody>
              {payments.data.map((p) => (
                <tr key={p.id} className={p.voided ? 'is-voided' : undefined}>
                  <td>{formatDate(p.paidAt)}</td>
                  <td className="wxp-tabular">
                    {formatInr(p.amountMinor)} {p.voided ? <StatusChip tone="neutral">{t('billing.voided')}</StatusChip> : null}
                  </td>
                  <td>{t(`billing.methods.${p.method}`)}</td>
                  <td>{p.reference}</td>
                  <td>{p.externalInvoiceNo ?? '—'}</td>
                  <td>
                    {formatDate(p.periodStart)} – {formatDate(p.periodEnd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {requests.data.length ? (
        <>
          <h2 className="section-title">{t('billing.requests')}</h2>
          <ul className="request-list">
            {requests.data.map((r) => (
              <li key={r.id} className="wxp-card request-list__item">
                <div>
                  <strong>{t(`billing.kinds.${r.kind}`)}</strong>
                  {r.quantity ? ` · ${t('billing.screensN', { count: r.quantity })}` : ''}
                  {r.planId ? ` · ${plans.data.find((p) => p.id === r.planId)?.name ?? r.planId}` : ''}
                  {r.message ? <p className="wxp-muted">{r.message}</p> : null}
                  {r.resolutionNote ? <p>{t('billing.wallxNote', { note: r.resolutionNote })}</p> : null}
                </div>
                <div className="request-list__meta">
                  <StatusChip tone={r.status === 'open' ? 'info' : r.status === 'done' ? 'success' : 'neutral'}>{t(`billing.requestStatus.${r.status}`)}</StatusChip>
                  <span className="wxp-muted">{formatDate(r.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {paying ? (
        <PayOnlineDialog
          orgId={orgId}
          sub={s}
          onClose={() => setPaying(false)}
          onPaid={(text) => {
            setPaying(false);
            setPaidText(text);
          }}
        />
      ) : null}
      <RequestDialog
        open={requesting}
        currentPlanId={s.planId}
        currentInterval={s.interval}
        currentQuantity={s.quantity}
        onClose={() => setRequesting(false)}
        onSent={() => {
          setRequesting(false);
          setSent(true);
        }}
      />
    </>
  );
}

function RequestDialog({
  open,
  currentPlanId,
  currentInterval,
  currentQuantity,
  onClose,
  onSent,
}: {
  open: boolean;
  currentPlanId: string;
  currentInterval: BillingInterval;
  currentQuantity: number;
  onClose: () => void;
  onSent: () => void;
}) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const plans = usePlans();
  const [kind, setKind] = useState<BillingRequestKind>('add_screens');
  const [planId, setPlanId] = useState(currentPlanId);
  const [interval, setInterval] = useState<BillingInterval>(currentInterval);
  const [quantity, setQuantity] = useState(String(currentQuantity + 1));
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paidPlans = plans.data.filter((p) => p.tier !== 'trial').sort((a, b) => (a.pricePerScreenMonthlyMinor ?? Infinity) - (b.pricePerScreenMonthlyMinor ?? Infinity));
  const needsQuantity = kind === 'add_screens' || kind === 'change_plan';
  const q = Number(quantity);
  const valid = (!needsQuantity || (Number.isInteger(q) && q >= 1)) && (kind !== 'other' || message.trim().length > 0);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await call('requestBillingChange', {
        orgId,
        kind,
        ...(kind === 'change_plan' ? { planId, interval } : {}),
        ...(needsQuantity ? { quantity: q } : {}),
        message,
      });
      setMessage('');
      onSent();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={t('billing.requestChange')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !valid} onClick={() => void send()}>
            {t('billing.send')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p className="wxp-muted">{t('billing.requestHelp')}</p>
      <SelectField
        label={t('billing.requestKind')}
        options={BILLING_REQUEST_KINDS.map((k) => ({ value: k, label: t(`billing.kinds.${k}`) }))}
        value={kind}
        onChange={(e) => setKind(e.target.value as BillingRequestKind)}
      />
      {kind === 'change_plan' ? (
        <div className="wxp-form__row">
          <SelectField
            label={t('billing.plan')}
            options={paidPlans.map((p) => ({
              value: p.id,
              label: p.pricePerScreenMonthlyMinor !== null ? t('billing.planOption', { name: p.name, price: formatInr(p.pricePerScreenMonthlyMinor) }) : p.name,
            }))}
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
          />
          <SelectField
            label={t('billing.interval')}
            options={(['monthly', 'annual'] as const).map((i) => ({ value: i, label: t(`billing.intervals.${i}`) }))}
            value={interval}
            onChange={(e) => setInterval(e.target.value as BillingInterval)}
          />
        </div>
      ) : null}
      {needsQuantity ? (
        <TextField label={t('billing.screensWanted')} type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      ) : null}
      <TextAreaField label={t('billing.message')} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
    </Dialog>
  );
}
