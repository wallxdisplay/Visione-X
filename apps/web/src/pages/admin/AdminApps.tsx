import { collection, query } from 'firebase/firestore';
import { Alert, Button, Dialog, PageHeader, SelectField, StatusChip, TextAreaField, TextField } from '@wallx-play/ui';
import {
  APP_UNITS,
  FEATURE_KEYS,
  UNSOLD_FEATURES,
  appReleaseStatus,
  catalogProblems,
  formatInr,
  hasPlatformPermission,
  paths,
  type AppCostDoc,
  type AppDoc,
  type AppUnit,
  type FeatureKey,
  type ReleaseStatus,
} from '@wallx-play/shared';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { parseRupees, rupees, useFeatureCatalog } from '../../content/billing';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { useQueryData } from '../../lib/hooks';
import '../billing/billing.css';
import './admin.css';

const RELEASE_TONE: Record<ReleaseStatus, 'success' | 'warning' | 'neutral'> = { ga: 'success', beta: 'warning', planned: 'neutral' };
/** Target gross margin for the "lowest price" hint (as in the price sheet). */
const TARGET_MARGIN = 0.7;

/** Super Admin → App catalog: what WallX sells, at what price, and what it costs to run. */
export function AdminApps() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const manage = hasPlatformPermission(platformRole, 'plan.manage');
  const apps = useQueryData<AppDoc>('admin:apps', () => query(collection(db, paths.apps())));
  const costs = useQueryData<AppCostDoc>('admin:appCosts', () => query(collection(db, paths.appCosts())));
  const catalog = useFeatureCatalog();
  const [editing, setEditing] = useState<{ app: AppDoc | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sorted = useMemo(() => [...apps.data].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), [apps.data]);
  const problems = catalogProblems(apps.data);
  const costOf = (id: string) => costs.data.find((c) => c.id === id);

  async function seed() {
    setError(null);
    try {
      const { added } = await call<{ added: number }>('seedAppCatalog', {});
      setNotice(t('adminApps.seeded', { count: added }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title={t('nav.admin.apps')}
        description={t('adminApps.description')}
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setEditing({ app: null })}>
              <Plus size={15} aria-hidden /> {t('adminApps.new')}
            </Button>
          ) : null
        }
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!apps.loading && apps.data.length === 0 ? (
        <Alert tone="info">
          {t('adminApps.empty')}{' '}
          {manage ? (
            <Button size="sm" variant="primary" onClick={() => void seed()}>
              {t('adminApps.seed')}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {apps.data.length > 0 && problems.unsold.length ? <Alert tone="warning">{t('adminApps.unsold', { list: problems.unsold.map((k) => t(`features.${k}`)).join(', ') })}</Alert> : null}
      <Alert tone="info">{t('adminApps.phaseNote')}</Alert>

      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('adminApps.app')}</th>
              <th>{t('adminApps.unit')}</th>
              <th>{t('adminApps.price')}</th>
              <th>{t('adminApps.dealerPrice')}</th>
              <th>{t('adminApps.cost')}</th>
              <th>{t('adminApps.margin')}</th>
              <th>{t('adminApps.release')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => {
              const cost = costOf(a.id)?.costMinor ?? null;
              const margin = cost !== null && a.priceMinor > 0 ? 1 - cost / a.priceMinor : null;
              const status = appReleaseStatus(a, catalog.data?.features ?? {});
              return (
                <tr key={a.id} className={a.active ? undefined : 'is-voided'}>
                  <td>
                    <strong>{a.name}</strong> {a.base ? <StatusChip tone="info">{t('adminApps.base')}</StatusChip> : null}
                    {!a.active ? <StatusChip tone="neutral">{t('adminApps.inactive')}</StatusChip> : null}
                    <div className="wxp-muted">{a.featureKeys.length ? a.featureKeys.map((k) => t(`features.${k}`)).join(', ') : a.limitBoosts.storageGB ? t('adminApps.storageBoost', { gb: a.limitBoosts.storageGB }) : '—'}</div>
                    {a.requires.length ? <div className="wxp-muted">{t('adminApps.needs', { list: a.requires.map((r) => apps.data.find((x) => x.id === r)?.name ?? r).join(', ') })}</div> : null}
                  </td>
                  <td>{t(`adminApps.units.${a.unit}`)}</td>
                  <td className="wxp-tabular">{formatInr(a.priceMinor)}</td>
                  <td className="wxp-tabular">{a.dealerPriceMinor === null ? <span className="wxp-muted">{t('adminApps.dealerDefault')}</span> : formatInr(a.dealerPriceMinor)}</td>
                  <td className="wxp-tabular">{cost === null ? '—' : formatInr(cost)}</td>
                  <td className="wxp-tabular">
                    {margin === null ? '—' : <StatusChip tone={margin >= TARGET_MARGIN ? 'success' : margin >= 0.4 ? 'warning' : 'danger'}>{`${Math.round(margin * 100)}%`}</StatusChip>}
                  </td>
                  <td>
                    <StatusChip tone={RELEASE_TONE[status]}>{t(`adminFeatures.statuses.${status}`)}</StatusChip>
                  </td>
                  <td className="wxp-actions">
                    {manage ? (
                      <Button size="sm" variant="tertiary" onClick={() => setEditing({ app: a })}>
                        {t('common.edit')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="wxp-muted">{t('adminApps.notes', { margin: Math.round(TARGET_MARGIN * 100) })}</p>

      {editing ? (
        <AppDialog
          app={editing.app}
          cost={editing.app ? (costOf(editing.app.id) ?? null) : null}
          all={apps.data}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            setNotice(t('adminApps.saved', { name }));
          }}
        />
      ) : null}
    </>
  );
}

interface Form {
  id: string;
  name: string;
  description: string;
  unit: AppUnit;
  featureKeys: FeatureKey[];
  requires: string[];
  base: boolean;
  storageGB: string;
  price: string;
  dealerPrice: string;
  cost: string;
  costNote: string;
  active: boolean;
  sortOrder: string;
  reason: string;
}

function AppDialog({ app, cost, all, onClose, onSaved }: { app: AppDoc | null; cost: AppCostDoc | null; all: AppDoc[]; onClose: () => void; onSaved: (name: string) => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState<Form>({
    id: app?.id ?? '',
    name: app?.name ?? '',
    description: app?.description ?? '',
    unit: app?.unit ?? 'screen',
    featureKeys: app?.featureKeys ?? [],
    requires: app?.requires ?? [],
    base: app?.base ?? false,
    storageGB: app?.limitBoosts.storageGB ? String(app.limitBoosts.storageGB) : '',
    price: rupees(app?.priceMinor ?? 0),
    dealerPrice: app?.dealerPriceMinor === null || app?.dealerPriceMinor === undefined ? '' : rupees(app.dealerPriceMinor),
    cost: rupees(cost?.costMinor ?? 0),
    costNote: cost?.note ?? '',
    active: app?.active ?? true,
    sortOrder: String(app?.sortOrder ?? (Math.max(0, ...all.map((a) => a.sortOrder)) + 10)),
    reason: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const toggle = (list: 'featureKeys' | 'requires', v: string) =>
    setF((p) => ({ ...p, [list]: (p[list] as string[]).includes(v) ? (p[list] as string[]).filter((x) => x !== v) : [...(p[list] as string[]), v] }));

  // Features another app already sells cannot be added here (one app per feature).
  const owner = (k: FeatureKey) => all.find((a) => a.id !== app?.id && a.featureKeys.includes(k));
  const price = parseRupees(f.price);
  const dealer = f.dealerPrice.trim() ? parseRupees(f.dealerPrice) : null;
  const costMinor = parseRupees(f.cost);
  const margin = price && costMinor !== null ? 1 - costMinor / price : null;
  const lowest = costMinor !== null ? Math.round(costMinor / (1 - TARGET_MARGIN)) : null;
  const ok =
    /^[a-z0-9-]{2,40}$/.test(f.id) &&
    f.name.trim().length >= 2 &&
    price !== null &&
    costMinor !== null &&
    (f.dealerPrice.trim() === '' || (dealer !== null && dealer <= price)) &&
    f.reason.trim().length >= 5;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('saveApp', {
        id: f.id,
        isNew: !app,
        name: f.name,
        description: f.description,
        unit: f.unit,
        featureKeys: f.featureKeys,
        requires: f.requires,
        base: f.base,
        storageGBPerUnit: f.storageGB.trim() ? Number(f.storageGB) : null,
        priceMinor: price,
        dealerPriceMinor: dealer,
        costMinor,
        costNote: f.costNote,
        active: f.active,
        sortOrder: Number(f.sortOrder) || 0,
        reason: f.reason,
      });
      onSaved(f.name);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="lg"
      title={app ? t('adminApps.edit', { name: app.name }) : t('adminApps.new')}
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
      <div className="wxp-form__row">
        <TextField label={t('adminApps.id')} hint={t('adminApps.idHint')} required disabled={!!app} maxLength={40} value={f.id} onChange={(e) => set('id', e.target.value.toLowerCase())} />
        <TextField label={t('adminApps.name')} required maxLength={60} value={f.name} onChange={(e) => set('name', e.target.value)} />
      </div>
      <TextAreaField label={t('adminApps.descriptionLabel')} rows={2} maxLength={300} value={f.description} onChange={(e) => set('description', e.target.value)} />
      <div className="wxp-form__row">
        <SelectField
          label={t('adminApps.unit')}
          options={APP_UNITS.map((u) => ({ value: u, label: t(`adminApps.units.${u}`) }))}
          value={f.unit}
          onChange={(e) => set('unit', e.target.value as AppUnit)}
        />
        <TextField label={t('adminApps.sortOrder')} type="number" min={0} max={1000} value={f.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} />
      </div>

      <fieldset className="check-group">
        <legend className="wxp-field__label">{t('adminApps.features')}</legend>
        <div className="app-feature-grid">
          {FEATURE_KEYS.filter((k) => !UNSOLD_FEATURES.includes(k)).map((k) => {
            const other = owner(k);
            return (
              <label key={k} className="checkbox-row" title={other ? t('adminApps.soldBy', { name: other.name }) : undefined}>
                <input type="checkbox" checked={f.featureKeys.includes(k)} disabled={!!other} onChange={() => toggle('featureKeys', k)} />
                {t(`features.${k}`)}
                {other ? <span className="wxp-muted"> · {other.name}</span> : null}
              </label>
            );
          })}
        </div>
      </fieldset>
      {all.filter((a) => a.id !== f.id).length ? (
        <fieldset className="check-group check-group--row">
          <legend className="wxp-field__label">{t('adminApps.requires')}</legend>
          {all
            .filter((a) => a.id !== f.id && !a.base)
            .map((a) => (
              <label key={a.id} className="day-chip">
                <input type="checkbox" checked={f.requires.includes(a.id)} onChange={() => toggle('requires', a.id)} />
                <span>{a.name}</span>
              </label>
            ))}
        </fieldset>
      ) : null}
      {f.unit === 'storage_10gb' ? (
        <TextField label={t('adminApps.storageGB')} type="number" min={1} value={f.storageGB} onChange={(e) => set('storageGB', e.target.value)} />
      ) : null}

      <div className="wxp-form__row">
        <TextField label={t('adminApps.priceLabel')} hint={t('adminApps.perUnit', { unit: t(`adminApps.units.${f.unit}`) })} inputMode="decimal" required value={f.price} onChange={(e) => set('price', e.target.value)} />
        <TextField
          label={t('adminApps.dealerLabel')}
          hint={t('adminApps.dealerHint')}
          inputMode="decimal"
          value={f.dealerPrice}
          error={f.dealerPrice.trim() && (dealer === null || (price !== null && dealer > price)) ? t('adminApps.dealerError') : undefined}
          onChange={(e) => set('dealerPrice', e.target.value)}
        />
      </div>
      <div className="wxp-form__row">
        <TextField
          label={t('adminApps.costLabel')}
          hint={margin === null ? t('adminApps.costHint') : t('adminApps.marginHint', { margin: Math.round(margin * 100), lowest: formatInr(lowest ?? 0) })}
          inputMode="decimal"
          required
          value={f.cost}
          onChange={(e) => set('cost', e.target.value)}
        />
        <TextField label={t('adminApps.costNote')} maxLength={300} value={f.costNote} onChange={(e) => set('costNote', e.target.value)} />
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
        {t('adminApps.activeLabel')}
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={f.base} disabled={f.unit !== 'screen'} onChange={(e) => set('base', e.target.checked)} />
        {t('adminApps.baseLabel')}
      </label>
      <TextField label={t('adminApps.reason')} hint={t('adminApps.reasonHint')} required maxLength={500} value={f.reason} onChange={(e) => set('reason', e.target.value)} />
    </Dialog>
  );
}
