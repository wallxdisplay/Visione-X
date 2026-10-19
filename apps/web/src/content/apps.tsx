import { collection, query } from 'firebase/firestore';
import { appReleaseStatus, formatInr, lineProblems, paths, type AppDoc, type AppUnit, type BillLine, type FeatureKey } from '@wallx-play/shared';
import { EmptyState } from '@wallx-play/ui';
import { Link } from 'react-router';
import { useOrg } from '../org/OrgProvider';
import { useFeatureCatalog } from './billing';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { db } from '../lib/firebase';
import { useQueryData } from '../lib/hooks';

/** The app catalog (App store), sorted for display. */
export function useAppCatalog(enabled = true) {
  const live = useQueryData<AppDoc>(enabled ? 'apps:catalog' : null, () => query(collection(db, paths.apps())));
  const data = useMemo(() => [...live.data].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), [live.data]);
  return { ...live, data };
}

/** A monthly bill as a table: base screens, apps, adjustment, total. */
export function BillLinesTable({ lines, totalLabel }: { lines: BillLine[]; totalLabel?: string }) {
  const { t } = useTranslation();
  const total = Math.max(0, lines.reduce((s, l) => s + l.totalMinor, 0));
  return (
    <div className="wxp-table-wrap">
      <table className="wxp-table bill-lines">
        <thead>
          <tr>
            <th>{t('appBilling.item')}</th>
            <th>{t('appBilling.units')}</th>
            <th>{t('appBilling.unitPrice')}</th>
            <th>{t('appBilling.perMonth')}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.kind}-${l.appId ?? i}`}>
              <td>{l.kind === 'adjustment' ? t('appBilling.adjustment') : l.name}</td>
              <td className="wxp-tabular">{l.kind === 'adjustment' ? '' : `${l.quantity} ${l.unit ? t(`appBilling.unitNames.${l.unit}`, { count: l.quantity }) : ''}`}</td>
              <td className="wxp-tabular">{l.kind === 'adjustment' ? '' : formatInr(l.unitPriceMinor)}</td>
              <td className="wxp-tabular">{formatInr(l.totalMinor)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>
              <strong>{totalLabel ?? t('appBilling.totalMonthly')}</strong>
            </td>
            <td className="wxp-tabular">
              <strong>{formatInr(total)}</strong>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export interface SellableApp {
  id: string;
  name: string;
  unit: AppUnit;
  /** Price shown per unit (list price, or the dealer price for resellers). */
  priceMinor: number;
  requires: string[];
}

/**
 * Number of units per app (screens with the app, once per organization, sensor devices, storage
 * packs). Shows problems (too many screens, missing dependencies) as the values change.
 */
export function AppQuantitiesEditor({
  apps,
  value,
  screens,
  onChange,
  disabled,
}: {
  apps: SellableApp[];
  value: Record<string, number>;
  screens: number;
  onChange: (next: Record<string, number>) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const problems = lineProblems(
    Object.entries(value).map(([appId, quantity]) => ({ appId, quantity })),
    apps.map((a) => ({ id: a.id, name: a.name, unit: a.unit, base: false, requires: a.requires, active: true })),
    screens,
  );
  const set = (id: string, q: number) => onChange({ ...value, [id]: Math.max(0, Math.floor(q || 0)) });
  return (
    <div className="app-quantities">
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('appBilling.app')}</th>
              <th>{t('appBilling.unitPrice')}</th>
              <th>{t('appBilling.units')}</th>
              <th>{t('appBilling.perMonth')}</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => {
              const q = value[a.id] ?? 0;
              const max = a.unit === 'screen' ? screens : a.unit === 'organization' ? 1 : undefined;
              return (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td className="wxp-tabular">
                    {formatInr(a.priceMinor)} <span className="wxp-muted">/ {t(`appBilling.unitNames.${a.unit}`, { count: 1 })}</span>
                  </td>
                  <td>
                    {a.unit === 'organization' ? (
                      <input type="checkbox" aria-label={a.name} disabled={disabled} checked={q > 0} onChange={(e) => set(a.id, e.target.checked ? 1 : 0)} />
                    ) : (
                      <span className="app-quantities__qty">
                        <input className="wxp-input" type="number" aria-label={a.name} min={0} max={max} disabled={disabled} value={q} onChange={(e) => set(a.id, Number(e.target.value))} />
                        {a.unit === 'screen' ? (
                          <button type="button" className="wxp-btn wxp-btn--tertiary wxp-btn--sm" disabled={disabled} onClick={() => set(a.id, q === screens ? 0 : screens)}>
                            {q === screens ? t('appBilling.none') : t('appBilling.allScreens')}
                          </button>
                        ) : null}
                      </span>
                    )}
                  </td>
                  <td className="wxp-tabular">{q ? formatInr(q * a.priceMinor) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {problems.length ? <p className="wxp-field__error">{problems.join(' ')}</p> : null}
    </div>
  );
}

/** Quantities map → request lines (zero lines dropped). */
export const toLines = (value: Record<string, number>) =>
  Object.entries(value)
    .filter(([, q]) => q > 0)
    .map(([appId, quantity]) => ({ appId, quantity }));

export const quantitiesOf = (lines: Array<{ appId: string; quantity: number }> | undefined): Record<string, number> =>
  Object.fromEntries((lines ?? []).map((l) => [l.appId, l.quantity]));

/** Problems with chosen quantities (empty = fine). */
export function quantityProblems(apps: SellableApp[], value: Record<string, number>, screens: number): string[] {
  return lineProblems(
    toLines(value),
    apps.map((a) => ({ id: a.id, name: a.name, unit: a.unit, base: false, requires: a.requires, active: true })),
    screens,
  );
}

/**
 * A page whose feature the organization does not have: names the app that sells it and links to
 * the App store (or says it is coming soon). Falls back to the page's own text when no app sells it.
 */
export function FeatureLocked({ feature, icon, title, fallback }: { feature: FeatureKey; icon: ReactNode; title: string; fallback: string }) {
  const { t } = useTranslation();
  const { can } = useOrg();
  const catalog = useAppCatalog();
  const releases = useFeatureCatalog();
  const app = catalog.data.find((a) => a.active && !a.base && a.featureKeys.includes(feature));
  const soon = app ? appReleaseStatus(app, releases.data?.features ?? {}) === 'planned' : false;
  const description = !app ? fallback : soon ? t('appLock.soon', { app: app.name }) : can('billing.view') ? t('appLock.available', { app: app.name }) : t('appLock.askOwner', { app: app.name });
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      action={app && !soon && can('billing.view') ? <Link className="wxp-btn wxp-btn--primary" to="/apps">{t('appLock.open')}</Link> : undefined}
    />
  );
}
