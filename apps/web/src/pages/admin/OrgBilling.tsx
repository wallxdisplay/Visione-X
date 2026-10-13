import { Alert, Button, Dialog, PageHeader, SelectField, Spinner, StatusChip, TextAreaField, TextField } from '@wallx-play/ui';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  PAYMENT_METHODS,
  formatInr,
  hasPlatformPermission,
  paths,
  paymentPeriod,
  type BillingInterval,
  type BillingRequestDoc,
  type EntitlementOverridesDoc,
  type EntitlementsDoc,
  type FeatureKey,
  type LimitKey,
  type OrgDoc,
  type PaymentDoc,
  type PaymentMethod,
  type SubscriptionDoc,
} from '@wallx-play/shared';
import { ArrowLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { parseRupees, rupees, useBillingRequests, usePayments, usePlans, useSubscription } from '../../content/billing';
import { call, errorMessage } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { useDoc, type WithId } from '../../lib/hooks';
import { STATUS_TONE } from '../billing/Billing';
import '../billing/billing.css';

/** "YYYY-MM-DD" ⇄ epoch ms. Dates are India dates: `end` = 23:59:59 IST, else 12:00 IST. */
const IST_MS = 5.5 * 3_600_000;
const toDateInput = (ms: number | null) => (ms ? new Date(ms + IST_MS).toISOString().slice(0, 10) : '');
function fromDateInput(s: string, end: boolean): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, end ? 23 : 12, end ? 59 : 0, end ? 59 : 0) - IST_MS;
}

/** Dialog that always asks for a reason (audited) and runs one callable. */
function ActionDialog({
  open,
  title,
  submitLabel,
  danger,
  reasonRequired = true,
  canSubmit = true,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  danger?: boolean;
  reasonRequired?: boolean;
  canSubmit?: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<unknown>;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setReason('');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      title={title}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy || !canSubmit || (reasonRequired && reason.trim().length < 5)} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {children}
      {reasonRequired ? (
        <TextAreaField label={t('adminBilling.reason')} hint={t('adminBilling.reasonHint')} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      ) : null}
    </Dialog>
  );
}

type Open = 'plan' | 'payment' | 'dates' | 'cancel' | 'overrides' | { void: PaymentDoc } | { resolve: BillingRequestDoc } | null;

export function OrgBilling() {
  const { t } = useTranslation();
  const { orgId = '' } = useParams();
  const { platformRole } = useAuth();
  const org = useDoc<OrgDoc>(paths.org(orgId));
  const sub = useSubscription(orgId);
  const ent = useDoc<EntitlementsDoc>(paths.orgEntitlements(orgId));
  const overrides = useDoc<EntitlementOverridesDoc>(paths.orgEntitlementOverrides(orgId));
  const payments = usePayments(orgId);
  const requests = useBillingRequests(orgId);
  const plans = usePlans(true);
  const [open, setOpen] = useState<Open>(null);
  const edit = hasPlatformPermission(platformRole, 'billing.override');
  const editLimits = hasPlatformPermission(platformRole, 'org.limits.edit');

  if (org.loading || sub.loading) return <Spinner label={t('common.loading')} />;
  const s = sub.data;
  if (!org.data || !s) {
    return (
      <>
        <Link to="/admin/billing" className="back-link">
          <ArrowLeft size={14} aria-hidden /> {t('adminBilling.back')}
        </Link>
        <p className="wxp-muted">{t('adminBilling.noSubscription')}</p>
      </>
    );
  }
  const plan = plans.data.find((p) => p.id === s.planId);

  return (
    <>
      <Link to="/admin/billing" className="back-link">
        <ArrowLeft size={14} aria-hidden /> {t('adminBilling.back')}
      </Link>
      <PageHeader title={org.data.name} description={t('adminBilling.orgDescription')} />

      <div className="admin-billing__grid">
        <section className="wxp-card">
          <h2 className="wxp-card__title">
            {plan?.name ?? s.planId} <StatusChip tone={STATUS_TONE[s.status]}>{t(`billing.status.${s.status}`)}</StatusChip>
          </h2>
          <dl className="wxp-dl">
            <dt>{t('billing.interval')}</dt>
            <dd>{t(`billing.intervals.${s.interval}`)}</dd>
            <dt>{t('adminBilling.screensPurchased')}</dt>
            <dd className="wxp-tabular">{s.quantity}</dd>
            <dt>{t('adminBilling.screenLimit')}</dt>
            <dd className="wxp-tabular">{ent.data?.limits.screens ?? '∞'}</dd>
            <dt>{t('adminBilling.pricing')}</dt>
            <dd>
              {s.customPriceMinor !== null ? t('adminBilling.customPerScreen', { price: formatInr(s.customPriceMinor) }) : t('adminBilling.listPrice')}
              {s.discountBps ? ` · ${t('adminBilling.discount', { pct: s.discountBps / 100 })}` : ''}
            </dd>
            <dt>{t('billing.price')}</dt>
            <dd>{s.amountPerPeriodMinor !== null ? `${formatInr(s.amountPerPeriodMinor)} ${t(`billing.perInterval.${s.interval}`)} ${t('billing.plusGst')}` : '—'}</dd>
            <dt>{t('billing.trialEnds')}</dt>
            <dd>{formatDate(s.trialEndsAt)}</dd>
            <dt>{t('billing.paidThrough')}</dt>
            <dd>
              {formatDate(s.currentPeriodEnd)} {s.cancelAtPeriodEnd ? <StatusChip tone="neutral">{t('adminBilling.cancelling')}</StatusChip> : null}
            </dd>
            <dt>{t('adminBilling.lastPayment')}</dt>
            <dd>{formatDate(s.lastPaymentAt)}</dd>
          </dl>
          {edit ? (
            <div className="admin-billing__actions">
              <Button variant="primary" onClick={() => setOpen('payment')}>
                {t('adminBilling.recordPayment')}
              </Button>
              <Button onClick={() => setOpen('plan')}>{t('adminBilling.changePlan')}</Button>
              <Button onClick={() => setOpen('dates')}>{t('adminBilling.adjustDates')}</Button>
              <Button variant="tertiary" onClick={() => setOpen('cancel')}>
                {s.cancelAtPeriodEnd ? t('adminBilling.undoCancel') : t('adminBilling.cancelAtEnd')}
              </Button>
            </div>
          ) : null}
        </section>

        <section className="wxp-card">
          <h2 className="wxp-card__title">{t('adminBilling.entitlements')}</h2>
          <p className="wxp-muted">{t('adminBilling.entitlementsHelp')}</p>
          <dl className="wxp-dl">
            {LIMIT_KEYS.map((k) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{t(`limits.${k}`)}</dt>
                <dd className="wxp-tabular">
                  {ent.data?.limits[k] ?? '∞'}
                  {overrides.data?.limits?.[k] !== undefined ? <span className="wxp-muted"> ({t('adminBilling.overridden')})</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          <p>
            <strong>{t('adminBilling.featureCount', { count: ent.data?.features.length ?? 0 })}</strong>
            {overrides.data?.grant?.length ? <span className="wxp-muted"> · {t('adminBilling.granted', { list: overrides.data.grant.join(', ') })}</span> : null}
            {overrides.data?.revoke?.length ? <span className="wxp-muted"> · {t('adminBilling.revoked', { list: overrides.data.revoke.join(', ') })}</span> : null}
          </p>
          {editLimits ? <Button onClick={() => setOpen('overrides')}>{t('adminBilling.editOverrides')}</Button> : null}
        </section>
      </div>

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
                  {r.interval ? ` · ${t(`billing.intervals.${r.interval}`)}` : ''}
                  <p className="wxp-muted">
                    {r.message || '—'} · {r.requestedByEmail ?? r.requestedBy}, {formatDateTime(r.createdAt)}
                  </p>
                  {r.resolutionNote ? <p>{r.resolutionNote}</p> : null}
                </div>
                <div className="request-list__meta">
                  <StatusChip tone={r.status === 'open' ? 'info' : r.status === 'done' ? 'success' : 'neutral'}>{t(`billing.requestStatus.${r.status}`)}</StatusChip>
                  {edit && r.status === 'open' ? (
                    <Button size="sm" onClick={() => setOpen({ resolve: r })}>
                      {t('adminBilling.resolve')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2 className="section-title">{t('billing.payments')}</h2>
      {payments.data.length === 0 ? (
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
                <th>{t('adminBilling.recordedBy')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {payments.data.map((p: WithId<PaymentDoc>) => (
                <tr key={p.id} className={p.voided ? 'is-voided' : undefined}>
                  <td>{formatDate(p.paidAt)}</td>
                  <td className="wxp-tabular">{formatInr(p.amountMinor)}</td>
                  <td>{t(`billing.methods.${p.method}`)}</td>
                  <td>{p.reference}</td>
                  <td>{p.externalInvoiceNo ?? '—'}</td>
                  <td>
                    {formatDate(p.periodStart)} – {formatDate(p.periodEnd)}
                  </td>
                  <td className="wxp-muted">{p.recordedByEmail ?? p.recordedBy}</td>
                  <td className="wxp-actions">
                    {p.voided ? (
                      <span className="wxp-muted" title={p.voided.reason}>
                        {t('billing.voided')}
                      </span>
                    ) : edit ? (
                      <Button size="sm" variant="tertiary" onClick={() => setOpen({ void: p })}>
                        {t('adminBilling.void')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open === 'plan' ? <PlanDialog orgId={orgId} sub={s} onClose={() => setOpen(null)} /> : null}
      {open === 'payment' ? <PaymentDialog orgId={orgId} sub={s} onClose={() => setOpen(null)} /> : null}
      {open === 'dates' ? <DatesDialog orgId={orgId} sub={s} onClose={() => setOpen(null)} /> : null}
      {open === 'cancel' ? (
        <ActionDialog
          open
          title={s.cancelAtPeriodEnd ? t('adminBilling.undoCancel') : t('adminBilling.cancelAtEnd')}
          submitLabel={s.cancelAtPeriodEnd ? t('adminBilling.undoCancel') : t('adminBilling.cancelAtEnd')}
          danger={!s.cancelAtPeriodEnd}
          onClose={() => setOpen(null)}
          onSubmit={(reason) => call('setCancellation', { orgId, cancelAtPeriodEnd: !s.cancelAtPeriodEnd, reason })}
        >
          <p>{s.cancelAtPeriodEnd ? t('adminBilling.undoCancelBody') : t('adminBilling.cancelBody', { date: formatDate(s.currentPeriodEnd) })}</p>
        </ActionDialog>
      ) : null}
      {open && typeof open === 'object' && 'void' in open ? (
        <ActionDialog
          open
          danger
          title={t('adminBilling.voidTitle')}
          submitLabel={t('adminBilling.void')}
          onClose={() => setOpen(null)}
          onSubmit={(reason) => call('voidPayment', { orgId, paymentId: open.void.id, reason })}
        >
          <p>{t('adminBilling.voidBody', { amount: formatInr(open.void.amountMinor), date: formatDate(open.void.paidAt) })}</p>
        </ActionDialog>
      ) : null}
      {open && typeof open === 'object' && 'resolve' in open ? <ResolveDialog orgId={orgId} request={open.resolve} onClose={() => setOpen(null)} /> : null}
      {open === 'overrides' ? <OverridesDialog orgId={orgId} current={overrides.data} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function PlanDialog({ orgId, sub, onClose }: { orgId: string; sub: SubscriptionDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const plans = usePlans(true);
  const [planId, setPlanId] = useState(sub.planId);
  const [interval, setInterval] = useState<BillingInterval>(sub.interval);
  const [quantity, setQuantity] = useState(String(sub.quantity));
  const [custom, setCustom] = useState(rupees(sub.customPriceMinor));
  const [discount, setDiscount] = useState(String(sub.discountBps / 100));
  const q = Number(quantity);
  const customMinor = custom.trim() ? parseRupees(custom) : null;
  const d = Number(discount);
  const valid = Number.isInteger(q) && q >= 1 && (custom.trim() === '' || customMinor !== null) && d >= 0 && d <= 100;
  return (
    <ActionDialog
      open
      title={t('adminBilling.changePlan')}
      submitLabel={t('common.save')}
      canSubmit={valid}
      onClose={onClose}
      onSubmit={(reason) =>
        call('updateSubscription', { orgId, planId, interval, quantity: q, customPriceMinor: customMinor, discountBps: Math.round(d * 100), reason })
      }
    >
      <div className="wxp-form__row">
        <SelectField
          label={t('billing.plan')}
          options={plans.data.map((p) => ({
            value: p.id,
            label: `${p.name}${p.pricePerScreenMonthlyMinor !== null ? ` · ${formatInr(p.pricePerScreenMonthlyMinor)}` : ''}${p.active ? '' : ` (${t('adminFeatures.inactive')})`}`,
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
      <div className="wxp-form__row">
        <TextField label={t('adminBilling.screensPurchased')} type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <TextField label={t('adminBilling.extraDiscount')} type="number" min={0} max={100} step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} />
      </div>
      <TextField
        label={t('adminBilling.customPrice')}
        hint={t('adminBilling.customPriceHint')}
        inputMode="decimal"
        value={custom}
        error={custom.trim() && customMinor === null ? t('adminBilling.amountInvalid') : undefined}
        onChange={(e) => setCustom(e.target.value)}
      />
    </ActionDialog>
  );
}

function PaymentDialog({ orgId, sub, onClose }: { orgId: string; sub: SubscriptionDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [paidOn, setPaidOn] = useState(toDateInput(Date.now()));
  const [periods, setPeriods] = useState('1');
  const [note, setNote] = useState('');
  const amountMinor = parseRupees(amount);
  const paidAt = fromDateInput(paidOn, false);
  const n = Number(periods);
  const valid = !!amountMinor && amountMinor > 0 && reference.trim().length > 0 && paidAt !== null && Number.isInteger(n) && n >= 1 && n <= 36;
  const preview = valid ? paymentPeriod(sub, n, Date.now()) : null;
  return (
    <ActionDialog
      open
      reasonRequired={false}
      title={t('adminBilling.recordPayment')}
      submitLabel={t('adminBilling.recordPayment')}
      canSubmit={valid}
      onClose={onClose}
      onSubmit={() =>
        call('recordPayment', {
          orgId,
          amountMinor,
          method,
          reference,
          ...(invoiceNo.trim() ? { externalInvoiceNo: invoiceNo } : {}),
          paidAt,
          periods: n,
          ...(note.trim() ? { note } : {}),
        })
      }
    >
      <p className="wxp-muted">{t('adminBilling.paymentHelp')}</p>
      <div className="wxp-form__row">
        <TextField
          label={t('adminBilling.amountReceived')}
          required
          inputMode="decimal"
          hint={sub.amountPerPeriodMinor !== null ? t('adminBilling.amountHint', { price: formatInr(sub.amountPerPeriodMinor), per: t(`billing.perInterval.${sub.interval}`) }) : undefined}
          value={amount}
          error={amount && !amountMinor ? t('adminBilling.amountInvalid') : undefined}
          onChange={(e) => setAmount(e.target.value)}
        />
        <SelectField label={t('billing.method')} options={PAYMENT_METHODS.map((m) => ({ value: m, label: t(`billing.methods.${m}`) }))} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} />
      </div>
      <div className="wxp-form__row">
        <TextField label={t('billing.reference')} hint={t('adminBilling.referenceHint')} required maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
        <TextField label={t('billing.invoiceNo')} hint={t('adminBilling.invoiceHint')} maxLength={60} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
      </div>
      <div className="wxp-form__row">
        <TextField label={t('billing.paidOn')} type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        <TextField
          label={t('adminBilling.periods', { interval: t(`billing.intervals.${sub.interval}`) })}
          type="number"
          min={1}
          max={36}
          value={periods}
          onChange={(e) => setPeriods(e.target.value)}
        />
      </div>
      {preview ? <Alert tone="info">{t('adminBilling.periodPreview', { from: formatDate(preview.start), to: formatDate(preview.end) })}</Alert> : null}
      <TextAreaField label={t('adminBilling.note')} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
    </ActionDialog>
  );
}

function DatesDialog({ orgId, sub, onClose }: { orgId: string; sub: SubscriptionDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const [trial, setTrial] = useState(toDateInput(sub.trialEndsAt));
  const [paid, setPaid] = useState(toDateInput(sub.currentPeriodEnd));
  const trialMs = trial ? fromDateInput(trial, true) : null;
  const paidMs = paid ? fromDateInput(paid, true) : null;
  const changes = {
    ...(trialMs !== sub.trialEndsAt ? { trialEndsAt: trialMs } : {}),
    ...(paidMs !== sub.currentPeriodEnd ? { currentPeriodEnd: paidMs } : {}),
  };
  return (
    <ActionDialog
      open
      title={t('adminBilling.adjustDates')}
      submitLabel={t('common.save')}
      canSubmit={Object.keys(changes).length > 0}
      onClose={onClose}
      onSubmit={(reason) => call('adjustBillingDates', { orgId, ...changes, reason })}
    >
      <p className="wxp-muted">{t('adminBilling.datesHelp')}</p>
      <div className="wxp-form__row">
        <TextField label={t('billing.trialEnds')} hint={t('adminBilling.clearHint')} type="date" value={trial} onChange={(e) => setTrial(e.target.value)} />
        <TextField label={t('billing.paidThrough')} hint={t('adminBilling.clearHint')} type="date" value={paid} onChange={(e) => setPaid(e.target.value)} />
      </div>
    </ActionDialog>
  );
}

function ResolveDialog({ orgId, request, onClose }: { orgId: string; request: BillingRequestDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'done' | 'declined'>('done');
  const [note, setNote] = useState('');
  return (
    <ActionDialog
      open
      reasonRequired={false}
      title={t('adminBilling.resolveTitle')}
      submitLabel={t('adminBilling.resolve')}
      canSubmit={status === 'done' || note.trim().length >= 5}
      onClose={onClose}
      onSubmit={() => call('resolveBillingRequest', { orgId, requestId: request.id, status, ...(note.trim() ? { note } : {}) })}
    >
      <p>
        {t(`billing.kinds.${request.kind}`)}
        {request.quantity ? ` · ${t('billing.screensN', { count: request.quantity })}` : ''} — {request.message || '—'}
      </p>
      <p className="wxp-muted">{t('adminBilling.resolveHelp')}</p>
      <SelectField
        label={t('adminBilling.outcome')}
        options={(['done', 'declined'] as const).map((v) => ({ value: v, label: t(`billing.requestStatus.${v}`) }))}
        value={status}
        onChange={(e) => setStatus(e.target.value as 'done' | 'declined')}
      />
      <TextAreaField label={t('adminBilling.noteToCustomer')} required={status === 'declined'} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
    </ActionDialog>
  );
}

function OverridesDialog({ orgId, current, onClose }: { orgId: string; current: EntitlementOverridesDoc | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Record<FeatureKey, 'plan' | 'grant' | 'revoke'>>(
    () =>
      Object.fromEntries(
        FEATURE_KEYS.map((k) => [k, current?.grant?.includes(k) ? 'grant' : current?.revoke?.includes(k) ? 'revoke' : 'plan']),
      ) as Record<FeatureKey, 'plan' | 'grant' | 'revoke'>,
  );
  const [limits, setLimits] = useState<Record<LimitKey, string>>(
    () => Object.fromEntries(LIMIT_KEYS.map((k) => [k, current?.limits?.[k] === undefined ? '' : current.limits[k] === null ? 'unlimited' : String(current.limits[k])])) as Record<LimitKey, string>,
  );
  const parsed = Object.fromEntries(
    LIMIT_KEYS.filter((k) => limits[k].trim() !== '').map((k) => [k, limits[k].trim() === 'unlimited' ? null : Number(limits[k])]),
  ) as Partial<Record<LimitKey, number | null>>;
  const valid = Object.values(parsed).every((v) => v === null || (Number.isInteger(v) && v >= 0));
  return (
    <ActionDialog
      open
      title={t('adminBilling.editOverrides')}
      submitLabel={t('common.save')}
      canSubmit={valid}
      onClose={onClose}
      onSubmit={(reason) =>
        call('setEntitlementOverrides', {
          orgId,
          grant: FEATURE_KEYS.filter((k) => mode[k] === 'grant'),
          revoke: FEATURE_KEYS.filter((k) => mode[k] === 'revoke'),
          limits: parsed,
          reason,
        })
      }
    >
      <p className="wxp-muted">{t('adminBilling.overridesHelp')}</p>
      <h3>{t('adminBilling.limitOverrides')}</h3>
      <div className="limits-grid">
        {LIMIT_KEYS.map((k) => (
          <TextField key={k} label={t(`limits.${k}`)} placeholder={t('adminBilling.fromPlan')} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
        ))}
      </div>
      <h3>{t('adminBilling.featureOverrides')}</h3>
      <div className="feature-grid">
        {FEATURE_KEYS.map((k) => (
          <SelectField
            key={k}
            label={t(`features.${k}`)}
            options={(['plan', 'grant', 'revoke'] as const).map((m) => ({ value: m, label: t(`adminBilling.overrideModes.${m}`) }))}
            value={mode[k]}
            onChange={(e) => setMode({ ...mode, [k]: e.target.value as 'plan' | 'grant' | 'revoke' })}
          />
        ))}
      </div>
    </ActionDialog>
  );
}
