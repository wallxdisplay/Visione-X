import { Alert, Button, Dialog, EmptyState, PageHeader, SelectField, Spinner, StatusChip, TextField } from '@wallx-play/ui';
import {
  CreatePartnerOrgInput,
  DEFAULT_TIMEZONE,
  INDIAN_STATES,
  PARTNER_TRIAL_DAYS,
  formatInr,
  type PartnerCustomer,
  type PartnerOverview,
} from '@wallx-play/shared';
import { Building2, ExternalLink, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { call, errorMessage } from '../../lib/api';
import { fieldErrors, formatDate, timezoneOptions } from '../../lib/format';
import { rememberOrg } from '../../org/OrgProvider';
import { usePartner } from '../../partner/PartnerProvider';
import { STATUS_TONE } from '../billing/Billing';
import { AccountStanding } from './PartnerBilling';
import './partner.css';

/** Partner portal → Customers: the reseller's customer organizations. */
export function PartnerCustomers() {
  const { t } = useTranslation();
  const { accountId, overview, overviewError, refresh } = usePartner();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PartnerCustomer | null>(null);
  const [starting, setStarting] = useState<PartnerCustomer | null>(null);
  const [created, setCreated] = useState<{ name: string; link: string | null; emailed: boolean } | null>(null);

  if (!overview) return overviewError ? <Alert tone="danger">{overviewError}</Alert> : <Spinner label={t('common.loading')} />;
  const customers = overview.customers;
  const used = customers.reduce((s, c) => s + c.screensUsed, 0);
  const bought = customers.reduce((s, c) => s + c.quantity, 0);

  function open(c: PartnerCustomer) {
    rememberOrg(c.orgId);
    // The customer app opens the remembered organization when it mounts.
    navigate('/');
  }

  return (
    <>
      <PageHeader
        title={t('partner.customers.title')}
        description={t('partner.customers.description')}
        actions={
          <Button variant="primary" disabled={overview.account.status !== 'active'} onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden /> {t('partner.customers.new')}
          </Button>
        }
      />
      <AccountStanding overview={overview} />
      {created ? (
        <Alert tone="success">
          {t('partner.customers.created', { name: created.name })}{' '}
          {created.link ? (created.emailed ? t('partner.customers.ownerEmailed') : t('partner.customers.ownerLink', { link: created.link })) : null}
        </Alert>
      ) : null}

      <div className="partner-stats">
        <div className="partner-stat">
          <span className="wxp-muted">{t('partner.customers.count')}</span>
          <strong className="wxp-tabular">{customers.length}</strong>
        </div>
        <div className="partner-stat">
          <span className="wxp-muted">{t('partner.customers.screens')}</span>
          <strong className="wxp-tabular">
            {used} / {bought}
          </strong>
        </div>
        <div className="partner-stat">
          <span className="wxp-muted">{t('partner.customers.monthly')}</span>
          <strong className="wxp-tabular">{overview.monthlyTotalMinor === null ? t('partner.priceToAgree') : formatInr(overview.monthlyTotalMinor)}</strong>
        </div>
      </div>

      {customers.length === 0 ? (
        <div className="wxp-card">
          <EmptyState
            icon={<Building2 size={24} aria-hidden />}
            title={t('partner.customers.emptyTitle')}
            description={t('partner.customers.emptyBody')}
            action={<Button variant="primary" onClick={() => setCreating(true)}>{t('partner.customers.new')}</Button>}
          />
        </div>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('partner.customers.name')}</th>
                <th>{t('partner.customers.plan')}</th>
                <th>{t('partner.customers.screensCol')}</th>
                <th>{t('partner.customers.billing')}</th>
                <th>{t('partner.customers.monthlyCol')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.orgId}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.status !== 'active' ? <div className="wxp-muted">{t(`status.${c.status}`)}</div> : null}
                    {!c.partnerAccess ? <div className="wxp-muted">{t('partner.customers.accessOff')}</div> : null}
                  </td>
                  <td>{c.planName}</td>
                  <td className="wxp-tabular">
                    {c.screensUsed} / {c.quantity}
                    <div className="wxp-muted">{t('partner.customers.online', { count: c.screensOnline })}</div>
                  </td>
                  <td>
                    <StatusChip tone={STATUS_TONE[c.billing.status]}>{t(`billing.status.${c.billing.status}`)}</StatusChip>
                    <div className="wxp-muted">
                      {!c.resellerBilled
                        ? t('partner.customers.billedByWallx')
                        : c.trialing
                          ? t('partner.customers.trialUntil', { date: formatDate(c.billing.trialEndsAt) })
                          : t('partner.customers.paidUntil', { date: formatDate(c.billing.currentPeriodEnd) })}
                    </div>
                  </td>
                  <td className="wxp-tabular">
                    {!c.resellerBilled ? '—' : c.trialing ? t('partner.customers.free') : c.monthlyMinor === null ? t('partner.priceToAgree') : formatInr(c.monthlyMinor)}
                  </td>
                  <td className="wxp-actions">
                    {c.partnerAccess ? (
                      <Button size="sm" variant="tertiary" onClick={() => open(c)}>
                        <ExternalLink size={14} aria-hidden /> {t('partner.customers.open')}
                      </Button>
                    ) : null}
                    {c.resellerBilled ? (
                      <Button size="sm" variant="tertiary" onClick={() => setEditing(c)}>
                        {t('partner.customers.changePlan')}
                      </Button>
                    ) : null}
                    {c.resellerBilled && c.trialing ? (
                      <Button size="sm" onClick={() => setStarting(c)}>
                        {t('partner.customers.startBilling')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <NewCustomerDialog
          accountId={accountId}
          overview={overview}
          onClose={() => setCreating(false)}
          onCreated={async (r) => {
            setCreating(false);
            setCreated(r);
            await refresh();
          }}
        />
      ) : null}
      {editing ? (
        <PlanDialog
          accountId={accountId}
          overview={overview}
          customer={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      ) : null}
      {starting ? (
        <StartBillingDialog
          accountId={accountId}
          overview={overview}
          customer={starting}
          onClose={() => setStarting(null)}
          onDone={async () => {
            setStarting(null);
            await refresh();
          }}
        />
      ) : null}
    </>
  );
}

function planOptions(overview: PartnerOverview, t: (k: string, o?: Record<string, unknown>) => string) {
  return overview.plans.map((p) => ({
    value: p.id,
    label: p.dealerPriceMinor === null ? `${p.name} · ${t('partner.priceToAgree')}` : t('partner.planOption', { name: p.name, price: formatInr(p.dealerPriceMinor) }),
  }));
}

function NewCustomerDialog({
  accountId,
  overview,
  onClose,
  onCreated,
}: {
  accountId: string;
  overview: PartnerOverview;
  onClose: () => void;
  onCreated: (r: { name: string; link: string | null; emailed: boolean }) => void;
}) {
  const { t } = useTranslation();
  const timezones = useMemo(timezoneOptions, []);
  const states = useMemo(() => INDIAN_STATES.map((s) => ({ value: s.code, label: s.name })), []);
  const [v, setV] = useState({
    orgName: '',
    contactName: '',
    phone: '',
    city: '',
    stateCode: '27',
    timezone: DEFAULT_TIMEZONE,
    ownerEmail: '',
    planId: overview.plans[0]?.id ?? '',
    quantity: '1',
    trial: true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((p) => ({ ...p, [k]: value }));
  const plan = overview.plans.find((p) => p.id === v.planId);
  const paidUp = overview.account.billingStatus === 'active' || overview.account.billingStatus === 'past_due';

  async function save() {
    const parsed = CreatePartnerOrgInput.safeParse({ ...v, accountId, quantity: Number(v.quantity) });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ orgId: string; inviteToken: string | null; emailed: boolean }>('createPartnerOrg', parsed.data);
      onCreated({ name: v.orgName, link: r.inviteToken ? `${window.location.origin}/invite/${r.inviteToken}` : null, emailed: r.emailed });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="lg"
      title={t('partner.customers.new')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !v.orgName.trim() || !v.planId} onClick={() => void save()}>
            {t('partner.customers.create')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField label={t('partner.customers.orgName')} required maxLength={120} value={v.orgName} error={errors.orgName} onChange={(e) => set('orgName', e.target.value)} />
      <div className="wxp-form__row">
        <TextField label={t('partner.customers.contactName')} required maxLength={80} value={v.contactName} error={errors.contactName} onChange={(e) => set('contactName', e.target.value)} />
        <TextField label={t('partner.customers.phone')} required type="tel" maxLength={20} value={v.phone} error={errors.phone} onChange={(e) => set('phone', e.target.value)} />
      </div>
      <div className="wxp-form__row">
        <TextField label={t('partner.customers.city')} required maxLength={80} value={v.city} error={errors.city} onChange={(e) => set('city', e.target.value)} />
        <SelectField label={t('partner.customers.state')} options={states} value={v.stateCode} onChange={(e) => set('stateCode', e.target.value)} />
      </div>
      <SelectField label={t('partner.customers.timezone')} options={timezones} value={v.timezone} onChange={(e) => set('timezone', e.target.value)} />
      <TextField
        label={t('partner.customers.ownerEmail')}
        hint={t('partner.customers.ownerEmailHint')}
        type="email"
        maxLength={200}
        value={v.ownerEmail}
        error={errors.ownerEmail}
        onChange={(e) => set('ownerEmail', e.target.value)}
      />
      <div className="wxp-form__row">
        <SelectField label={t('partner.customers.plan')} options={planOptions(overview, t)} value={v.planId} onChange={(e) => set('planId', e.target.value)} />
        <TextField
          label={t('partner.customers.quantity')}
          hint={plan?.screenLimit ? t('partner.customers.quantityMax', { count: plan.screenLimit }) : undefined}
          type="number"
          min={1}
          value={v.quantity}
          error={errors.quantity}
          onChange={(e) => set('quantity', e.target.value)}
        />
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={v.trial} onChange={(e) => set('trial', e.target.checked)} />
        {t('partner.customers.trial', { days: PARTNER_TRIAL_DAYS })}
      </label>
      {!v.trial && !paidUp ? <Alert tone="warning">{t('partner.notPaidUp')}</Alert> : null}
      <p className="wxp-muted">{t('partner.customers.autoApproved')}</p>
    </Dialog>
  );
}

function PlanDialog({
  accountId,
  overview,
  customer,
  onClose,
  onSaved,
}: {
  accountId: string;
  overview: PartnerOverview;
  customer: PartnerCustomer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [planId, setPlanId] = useState(overview.plans.some((p) => p.id === customer.planId) ? customer.planId : (overview.plans[0]?.id ?? ''));
  const [quantity, setQuantity] = useState(String(customer.quantity));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const plan = overview.plans.find((p) => p.id === planId);
  const n = Number(quantity);
  const ok = Number.isInteger(n) && n >= Math.max(1, customer.screensUsed);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('setPartnerSubscription', { accountId, orgId: customer.orgId, planId, quantity: n });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('partner.customers.planFor', { name: customer.name })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !ok} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <SelectField label={t('partner.customers.plan')} options={planOptions(overview, t)} value={planId} onChange={(e) => setPlanId(e.target.value)} />
      <TextField
        label={t('partner.customers.quantity')}
        hint={t('partner.customers.quantityHint', { used: customer.screensUsed })}
        type="number"
        min={Math.max(1, customer.screensUsed)}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
      />
      {plan && ok && !customer.trialing && plan.dealerPriceMinor !== null ? (
        <p className="wxp-muted">{t('partner.customers.newMonthly', { amount: formatInr(plan.dealerPriceMinor * n) })}</p>
      ) : null}
    </Dialog>
  );
}

function StartBillingDialog({
  accountId,
  overview,
  customer,
  onClose,
  onDone,
}: {
  accountId: string;
  overview: PartnerOverview;
  customer: PartnerCustomer;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paidUp = overview.account.billingStatus === 'active' || overview.account.billingStatus === 'past_due';

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await call('startPartnerBilling', { accountId, orgId: customer.orgId });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('partner.customers.startBillingFor', { name: customer.name })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !paidUp} onClick={() => void start()}>
            {t('partner.customers.startBilling')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {paidUp ? (
        <p>
          {t('partner.customers.startBillingBody', {
            amount: customer.dealerPriceMinor === null ? t('partner.priceToAgree') : formatInr(customer.dealerPriceMinor * customer.quantity),
            date: formatDate(overview.account.paidThrough),
          })}
        </p>
      ) : (
        <Alert tone="warning">{t('partner.notPaidUp')}</Alert>
      )}
    </Dialog>
  );
}
