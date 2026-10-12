import { Alert, Button, Dialog, PageHeader, SelectField, StatusChip, TextAreaField, TextField } from '@visione-x/ui';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  RELEASE_STATUSES,
  formatInr,
  hasPlatformPermission,
  type FeatureKey,
  type LimitKey,
  type Plan,
  type ReleaseStatus,
} from '@visione-x/shared';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { parseRupees, rupees, useFeatureCatalog, usePlans } from '../../content/billing';
import { call, errorMessage } from '../../lib/api';
import type { WithId } from '../../lib/hooks';
import '../billing/billing.css';

const RELEASE_TONE: Record<ReleaseStatus, 'success' | 'warning' | 'neutral'> = { ga: 'success', beta: 'warning', planned: 'neutral' };
const TIERS = ['trial', 'starter', 'professional', 'enterprise', 'custom'] as const;

/** Plans (prices, limits, features) and the release status of each feature. */
export function AdminFeatures() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const manage = hasPlatformPermission(platformRole, 'plan.manage');
  const plans = usePlans(true);
  const catalog = useFeatureCatalog();
  const [editing, setEditing] = useState<{ plan: Plan | null } | null>(null);
  const [release, setRelease] = useState<{ key: FeatureKey; to: ReleaseStatus } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sorted = [...plans.data].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));

  return (
    <>
      <PageHeader
        title={t('nav.admin.features')}
        description={t('adminFeatures.description')}
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setEditing({ plan: null })}>
              <Plus size={15} aria-hidden /> {t('adminFeatures.newPlan')}
            </Button>
          ) : null
        }
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <h2 className="section-title">{t('adminFeatures.plans')}</h2>
      <div className="vx-table-wrap">
        <table className="vx-table">
          <thead>
            <tr>
              <th>{t('adminFeatures.plan')}</th>
              <th>{t('adminFeatures.price')}</th>
              <th>{t('adminFeatures.annualDiscount')}</th>
              <th>{t('limits.screens')}</th>
              <th>{t('limits.users')}</th>
              <th>{t('limits.storageGB')}</th>
              <th>{t('adminFeatures.features')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((p: WithId<Plan>) => (
              <tr key={p.id}>
                <td>
                  {p.name} <span className="vx-muted">({p.id})</span> {p.active ? null : <StatusChip tone="neutral">{t('adminFeatures.inactive')}</StatusChip>}
                </td>
                <td className="vx-tabular">{p.pricePerScreenMonthlyMinor !== null ? formatInr(p.pricePerScreenMonthlyMinor) : t('adminFeatures.custom')}</td>
                <td className="vx-tabular">{p.annualDiscountBps / 100}%</td>
                <td className="vx-tabular">{p.limits.screens ?? t('adminFeatures.purchased')}</td>
                <td className="vx-tabular">{p.limits.users ?? '∞'}</td>
                <td className="vx-tabular">{p.limits.storageGB ?? '∞'}</td>
                <td className="vx-tabular">{p.featureKeys.length}</td>
                <td className="vx-actions">
                  {manage ? (
                    <Button size="sm" variant="tertiary" onClick={() => setEditing({ plan: p })}>
                      {t('common.edit')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="section-title">{t('adminFeatures.release')}</h2>
      <p className="vx-muted">{t('adminFeatures.releaseHelp')}</p>
      <div className="vx-table-wrap">
        <table className="vx-table">
          <thead>
            <tr>
              <th>{t('adminFeatures.feature')}</th>
              <th>{t('adminFeatures.key')}</th>
              <th>{t('adminFeatures.status')}</th>
            </tr>
          </thead>
          <tbody>
            {FEATURE_KEYS.map((k) => {
              const status = catalog.data?.features[k] ?? 'planned';
              return (
                <tr key={k}>
                  <td>{t(`features.${k}`)}</td>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>
                    {manage ? (
                      <select
                        className="vx-input"
                        aria-label={t('adminFeatures.statusFor', { feature: t(`features.${k}`) })}
                        value={status}
                        onChange={(e) => setRelease({ key: k, to: e.target.value as ReleaseStatus })}
                      >
                        {RELEASE_STATUSES.map((r) => (
                          <option key={r} value={r}>
                            {t(`adminFeatures.statuses.${r}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <StatusChip tone={RELEASE_TONE[status]}>{t(`adminFeatures.statuses.${status}`)}</StatusChip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing ? (
        <PlanDialog
          plan={editing.plan}
          onClose={() => setEditing(null)}
          onSaved={(n) => {
            setEditing(null);
            setNotice(t('adminFeatures.saved', { count: n }));
          }}
        />
      ) : null}
      {release ? (
        <ReleaseDialog
          change={release}
          onClose={() => setRelease(null)}
          onSaved={(n) => {
            setRelease(null);
            setNotice(t('adminFeatures.saved', { count: n }));
          }}
        />
      ) : null}
    </>
  );
}

function ReasonFooter({ busy, canSubmit, onCancel, onSubmit, label }: { busy: boolean; canSubmit: boolean; onCancel: () => void; onSubmit: () => void; label: string }) {
  const { t } = useTranslation();
  return (
    <>
      <Button onClick={onCancel}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={busy || !canSubmit} onClick={onSubmit}>
        {label}
      </Button>
    </>
  );
}

function ReleaseDialog({ change, onClose, onSaved }: { change: { key: FeatureKey; to: ReleaseStatus }; onClose: () => void; onSaved: (n: number) => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ orgsUpdated: number }>('setFeatureRelease', { key: change.key, releaseStatus: change.to, reason });
      onSaved(r.orgsUpdated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={t('adminFeatures.releaseTitle', { feature: t(`features.${change.key}`), status: t(`adminFeatures.statuses.${change.to}`) })}
      onClose={onClose}
      footer={<ReasonFooter busy={busy} canSubmit={reason.trim().length >= 5} onCancel={onClose} onSubmit={() => void save()} label={t('common.save')} />}
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p>{t(`adminFeatures.releaseEffect.${change.to}`)}</p>
      <TextAreaField label={t('adminBilling.reason')} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}

function PlanDialog({ plan, onClose, onSaved }: { plan: Plan | null; onClose: () => void; onSaved: (n: number) => void }) {
  const { t } = useTranslation();
  const [id, setId] = useState(plan?.id ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [tier, setTier] = useState<Plan['tier']>(plan?.tier ?? 'custom');
  const [price, setPrice] = useState(rupees(plan?.pricePerScreenMonthlyMinor ?? null));
  const [annual, setAnnual] = useState(String((plan?.annualDiscountBps ?? 1500) / 100));
  const [trialDays, setTrialDays] = useState(String(plan?.trialDays ?? 0));
  const [limits, setLimits] = useState<Record<LimitKey, string>>(
    () => Object.fromEntries(LIMIT_KEYS.map((k) => [k, plan?.limits[k] === null || plan?.limits[k] === undefined ? '' : String(plan.limits[k])])) as Record<LimitKey, string>,
  );
  const [features, setFeatures] = useState<Set<FeatureKey>>(new Set(plan?.featureKeys ?? []));
  const [active, setActive] = useState(plan?.active ?? true);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const priceMinor = price.trim() ? parseRupees(price) : null;
  const limitValues = Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k].trim() === '' ? null : Number(limits[k])])) as Record<LimitKey, number | null>;
  const valid =
    /^[a-z0-9-]{2,40}$/.test(id) &&
    name.trim().length >= 2 &&
    (price.trim() === '' || priceMinor !== null) &&
    Object.values(limitValues).every((v) => v === null || (Number.isInteger(v) && v >= 0)) &&
    reason.trim().length >= 5;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ orgsUpdated: number }>('savePlan', {
        id,
        isNew: !plan,
        name,
        tier,
        pricePerScreenMonthlyMinor: priceMinor,
        annualDiscountBps: Math.round(Number(annual) * 100),
        trialDays: Number(trialDays),
        limits: limitValues,
        featureKeys: [...features],
        active,
        reason,
      });
      onSaved(r.orgsUpdated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="lg"
      title={plan ? t('adminFeatures.editPlan', { name: plan.name }) : t('adminFeatures.newPlan')}
      onClose={onClose}
      footer={<ReasonFooter busy={busy} canSubmit={valid} onCancel={onClose} onSubmit={() => void save()} label={t('common.save')} />}
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {plan ? <Alert tone="info">{t('adminFeatures.editWarning')}</Alert> : null}
      <div className="vx-form__row">
        <TextField label={t('adminFeatures.planId')} hint={t('adminFeatures.planIdHint')} required disabled={!!plan} value={id} onChange={(e) => setId(e.target.value.toLowerCase())} />
        <TextField label={t('adminFeatures.planName')} required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="vx-form__row">
        <SelectField label={t('adminFeatures.tier')} options={TIERS.map((v) => ({ value: v, label: t(`adminFeatures.tiers.${v}`) }))} value={tier} onChange={(e) => setTier(e.target.value as Plan['tier'])} />
        <TextField
          label={t('adminFeatures.price')}
          hint={t('adminFeatures.priceHint')}
          inputMode="decimal"
          value={price}
          error={price.trim() && priceMinor === null ? t('adminBilling.amountInvalid') : undefined}
          onChange={(e) => setPrice(e.target.value)}
        />
      </div>
      <div className="vx-form__row">
        <TextField label={t('adminFeatures.annualDiscount')} type="number" min={0} max={100} step="0.01" value={annual} onChange={(e) => setAnnual(e.target.value)} />
        <TextField label={t('adminFeatures.trialDays')} type="number" min={0} max={90} value={trialDays} onChange={(e) => setTrialDays(e.target.value)} />
      </div>
      <h3>{t('adminFeatures.limits')}</h3>
      <p className="vx-muted">{t('adminFeatures.limitsHint')}</p>
      <div className="limits-grid">
        {LIMIT_KEYS.map((k) => (
          <TextField key={k} label={t(`limits.${k}`)} type="number" min={0} placeholder="∞" value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
        ))}
      </div>
      <h3>{t('adminFeatures.features')}</h3>
      <div className="feature-grid">
        {FEATURE_KEYS.map((k) => (
          <label key={k} className="checkbox-row">
            <input
              type="checkbox"
              checked={features.has(k)}
              onChange={(e) => {
                const next = new Set(features);
                if (e.target.checked) next.add(k);
                else next.delete(k);
                setFeatures(next);
              }}
            />
            {t(`features.${k}`)}
          </label>
        ))}
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        {t('adminFeatures.activeLabel')}
      </label>
      <TextAreaField label={t('adminBilling.reason')} hint={t('adminBilling.reasonHint')} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}
