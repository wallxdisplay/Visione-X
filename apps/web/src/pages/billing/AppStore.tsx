import { Alert, Button, Dialog, EmptyState, PageHeader, Spinner, StatusChip } from '@wallx-play/ui';
import {
  appReleaseStatus,
  appsBasePriceMinor,
  billLines,
  billTotalMinor,
  formatInr,
  lineProblems,
  stateAfter,
  type AppChangeItem,
  type AppDoc,
  type AppUnit,
  type ChangeAppsResult,
  type SubscriptionDoc,
} from '@wallx-play/shared';
import { Minus, Plus, Store } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAppCatalog } from '../../content/apps';
import { useFeatureCatalog, usePlans, useSubscription } from '../../content/billing';
import { useScreens } from '../../content/data';
import { call, errorMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';
import './billing.css';

const GROUPS: Array<{ key: string; units: AppUnit[] }> = [
  { key: 'screen', units: ['screen'] },
  { key: 'organization', units: ['organization'] },
  { key: 'extras', units: ['sensor_device', 'storage_10gb'] },
];

interface Draft {
  screens: number;
  qty: Record<string, number>;
}

/** What the customer will have once scheduled reductions apply: the starting point for changes. */
function draftOf(sub: SubscriptionDoc): Draft {
  const after = stateAfter({ screens: sub.quantity, lines: sub.apps ?? [] }, sub.scheduledChange);
  return { screens: after.screens, qty: Object.fromEntries(after.lines.map((l) => [l.appId, l.quantity])) };
}

const linesOf = (d: Draft) =>
  Object.entries(d.qty)
    .filter(([, q]) => q > 0)
    .map(([appId, quantity]) => ({ appId, quantity }));

/** App store: owners choose screens and apps; prices per app, changes previewed before they apply. */
export function AppStore() {
  const { t } = useTranslation();
  const { orgId, can, siteScope, org } = useOrg();
  const view = can('billing.view');
  const manage = can('billing.manage');
  const sub = useSubscription(view ? orgId : null);
  const plans = usePlans();
  const catalog = useAppCatalog(view);
  const features = useFeatureCatalog();
  const screens = useScreens(orgId, siteScope);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // Start again from the saved subscription whenever it changes.
  const s = sub.data;
  useEffect(() => {
    if (s) setDraft(draftOf(s));
  }, [s?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = plans.data.find((p) => p.id === s?.planId);
  const base = catalog.data.find((a) => a.base);
  const monthly = useMemo(() => {
    if (!s || !plan || !draft) return null;
    // Owned lines keep their locked price; new ones show today's price.
    const lines = linesOf(draft).map((l) => {
      const had = (s.apps ?? []).find((x) => x.appId === l.appId);
      return { ...l, unitPriceMinor: had?.unitPriceMinor ?? catalog.data.find((a) => a.id === l.appId)?.priceMinor ?? 0, addedAt: 0 };
    });
    return billTotalMinor(billLines({ screens: draft.screens, basePriceMinor: appsBasePriceMinor(plan, base, s.customPriceMinor), lines, adjustmentMinor: s.adjustmentMinor ?? 0, catalog: catalog.data }));
  }, [s, plan, base, draft, catalog.data]);

  if (!view) {
    return (
      <>
        <PageHeader title={t('nav.appStore')} />
        <div className="wxp-card">
          <EmptyState icon={<Store size={24} aria-hidden />} title={t('billing.noAccessTitle')} description={t('billing.noAccessBody')} />
        </div>
      </>
    );
  }
  if (sub.loading || catalog.loading) return <Spinner label={t('common.loading')} />;
  if (!s || !draft) return <PageHeader title={t('nav.appStore')} description={t('billing.none')} />;

  const header = <PageHeader title={t('nav.appStore')} description={t('appStore.description')} />;
  if (s.billedTo) {
    return (
      <>
        {header}
        <Alert tone="info">{t('appStore.viaReseller', { name: org?.partnerName ?? t('billing.yourReseller') })}</Alert>
      </>
    );
  }
  if (s.pricing !== 'apps' || !base) {
    return (
      <>
        {header}
        <Alert tone="info">{t('appStore.planPricing')}</Alert>
        <Link to="/billing">{t('appStore.toBilling')}</Link>
      </>
    );
  }

  const owned = (s.apps ?? []).map((l) => l.appId);
  const sellable = catalog.data.filter((a) => !a.base && (a.active || owned.includes(a.id)));
  const status = (a: AppDoc) => appReleaseStatus(a, features.data?.features ?? {});
  const authorized = screens.data.filter((x) => x.status === 'authorized').length;
  const problems = [
    ...lineProblems(linesOf(draft), catalog.data, draft.screens, owned),
    ...(authorized > draft.screens ? [t('appStore.tooFewScreens', { count: authorized })] : []),
  ];
  const saved = draftOf(s);
  const changed = JSON.stringify(saved) !== JSON.stringify({ screens: draft.screens, qty: Object.fromEntries(Object.entries(draft.qty).filter(([, q]) => q > 0)) });
  const setQty = (id: string, q: number) => setDraft({ ...draft, qty: { ...draft.qty, [id]: Math.max(0, Math.floor(q || 0)) } });
  const nameOf = (item: string) => (item === 'screens' ? t('appStore.screens') : (catalog.data.find((a) => a.id === item)?.name ?? item));
  const pendingTotal = (s.pendingCharges ?? []).reduce((sum, c) => sum + c.amountMinor, 0);
  const trialing = s.status === 'trialing' && s.currentPeriodEnd === null;

  return (
    <>
      {header}
      {done ? <Alert tone="success">{done}</Alert> : null}
      {trialing ? <Alert tone="info">{t('appStore.trial', { date: formatDate(s.trialEndsAt) })}</Alert> : null}
      {s.scheduledChange ? (
        <Alert tone="warning">
          {t('appStore.scheduled', { date: formatDate(s.scheduledChange.effectiveAt) })}{' '}
          {[
            ...(s.scheduledChange.screens !== undefined ? [`${t('appStore.screens')}: ${s.quantity} → ${s.scheduledChange.screens}`] : []),
            ...s.scheduledChange.apps.map((a) => `${nameOf(a.appId)}: ${(s.apps ?? []).find((l) => l.appId === a.appId)?.quantity ?? 0} → ${a.quantity}`),
          ].join(' · ')}
        </Alert>
      ) : null}
      {pendingTotal > 0 ? <Alert tone="info">{t('appStore.pending', { amount: formatInr(pendingTotal) })}</Alert> : null}
      {!manage ? <Alert tone="info">{t('appStore.ownerOnly')}</Alert> : null}

      <div className="app-store">
        <div className="app-store__main">
          <section className="wxp-card app-store__screens">
            <div>
              <h2 className="wxp-card__title">{t('appStore.screens')}</h2>
              <p className="wxp-muted">
                {t('appStore.screensHelp', { price: formatInr(appsBasePriceMinor(plan!, base, s.customPriceMinor)), name: base.name })}{' '}
                {t('appStore.authorized', { count: authorized })}
              </p>
            </div>
            <Stepper value={draft.screens} min={1} disabled={!manage} label={t('appStore.screens')} onChange={(v) => setDraft({ ...draft, screens: Math.max(1, v) })} />
          </section>

          {GROUPS.map((g) => {
            const apps = sellable.filter((a) => g.units.includes(a.unit));
            if (!apps.length) return null;
            return (
              <section key={g.key}>
                <h2 className="section-title">{t(`appStore.groups.${g.key}`)}</h2>
                <div className="app-store__grid">
                  {apps.map((a) => {
                    const q = draft.qty[a.id] ?? 0;
                    const release = status(a);
                    const soon = release === 'planned' && !owned.includes(a.id);
                    return (
                      <article key={a.id} className={`wxp-card app-card${q > 0 ? ' is-on' : ''}`}>
                        <div className="app-card__head">
                          <h3>{a.name}</h3>
                          {soon ? <StatusChip tone="neutral">{t('appStore.soon')}</StatusChip> : release === 'beta' ? <StatusChip tone="info">{t('appStore.beta')}</StatusChip> : null}
                        </div>
                        <p className="wxp-muted app-card__desc">{a.description}</p>
                        {a.requires.length ? <p className="wxp-muted app-card__needs">{t('appStore.needs', { list: a.requires.map(nameOf).join(', ') })}</p> : null}
                        <div className="app-card__foot">
                          <span className="wxp-tabular">
                            <strong>{formatInr(a.priceMinor)}</strong> <span className="wxp-muted">/ {t(`appBilling.unitNames.${a.unit}`, { count: 1 })} / {t('appStore.month')}</span>
                          </span>
                          {a.unit === 'organization' ? (
                            <Button size="sm" variant={q > 0 ? 'tertiary' : 'primary'} disabled={!manage || (soon && q === 0)} onClick={() => setQty(a.id, q > 0 ? 0 : 1)}>
                              {q > 0 ? t('appStore.remove') : t('appStore.add')}
                            </Button>
                          ) : (
                            <span className="app-card__qty">
                              <Stepper value={q} min={0} disabled={!manage || (soon && q === 0)} label={a.name} onChange={(v) => setQty(a.id, v)} />
                              {a.unit === 'screen' && manage && !soon ? (
                                <button type="button" className="wxp-btn wxp-btn--tertiary wxp-btn--sm" onClick={() => setQty(a.id, q === draft.screens ? 0 : draft.screens)}>
                                  {q === draft.screens ? t('appBilling.none') : t('appBilling.allScreens')}
                                </button>
                              ) : null}
                            </span>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
          <p className="wxp-muted">
            {t('appStore.placeHint')} <Link to="/screens">{t('appStore.toScreens')}</Link>
          </p>
        </div>

        <aside className="wxp-card app-store__summary">
          <h2 className="wxp-card__title">{t('appStore.summary')}</h2>
          <p className="app-store__total wxp-tabular">
            {monthly !== null ? formatInr(monthly) : '—'} <span className="wxp-muted">/ {t('appStore.month')}</span>
          </p>
          <p className="wxp-muted">{t('appStore.summaryNote')}</p>
          {problems.length ? <p className="wxp-field__error">{problems.join(' ')}</p> : null}
          {manage ? (
            <div className="app-store__actions">
              <Button variant="primary" disabled={!changed || problems.length > 0} onClick={() => setReview(true)}>
                {t('appStore.review')}
              </Button>
              {changed ? <Button variant="tertiary" onClick={() => setDraft(saved)}>{t('appStore.reset')}</Button> : null}
            </div>
          ) : null}
        </aside>
      </div>

      {review ? (
        <ReviewDialog
          orgId={orgId}
          draft={draft}
          interval={s.interval}
          nameOf={nameOf}
          onClose={() => setReview(false)}
          onDone={(text) => {
            setReview(false);
            setDone(text);
          }}
        />
      ) : null}
    </>
  );
}

function Stepper({ value, min, disabled, label, onChange }: { value: number; min: number; disabled?: boolean; label: string; onChange: (v: number) => void }) {
  const { t } = useTranslation();
  return (
    <span className="stepper">
      <button type="button" className="wxp-btn wxp-btn--sm" aria-label={t('appStore.less', { name: label })} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>
        <Minus size={14} aria-hidden />
      </button>
      <input className="wxp-input" type="number" aria-label={label} min={min} disabled={disabled} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <button type="button" className="wxp-btn wxp-btn--sm" aria-label={t('appStore.more', { name: label })} disabled={disabled} onClick={() => onChange(value + 1)}>
        <Plus size={14} aria-hidden />
      </button>
    </span>
  );
}

/** Server preview of the change (what is charged, what waits for the period end), then apply. */
function ReviewDialog({
  orgId,
  draft,
  interval,
  nameOf,
  onClose,
  onDone,
}: {
  orgId: string;
  draft: Draft;
  interval: SubscriptionDoc['interval'];
  nameOf: (item: string) => string;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ChangeAppsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = { orgId, screens: draft.screens, apps: linesOf(draft) };

  useEffect(() => {
    call<ChangeAppsResult>('changeApps', { ...input, apply: false }).then(setPreview, (err) => setError(errorMessage(err)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const r = await call<ChangeAppsResult>('changeApps', { ...input, apply: true });
      onDone(r.chargeMinor > 0 ? t('appStore.doneCharged', { amount: formatInr(r.chargeMinor) }) : t('appStore.done'));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const item = (i: AppChangeItem) => (
    <li key={i.item}>
      {nameOf(i.item)}: {i.from} → {i.to}
    </li>
  );
  const per = t(`billing.perInterval.${interval}`);
  return (
    <Dialog
      open
      title={t('appStore.reviewTitle')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !preview} onClick={() => void apply()}>
            {t('appStore.confirm')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!preview && !error ? <Spinner label={t('common.loading')} /> : null}
      {preview ? (
        <>
          {preview.increases.length ? (
            <>
              <h3 className="section-title">{t('appStore.addingNow')}</h3>
              <ul>{preview.increases.map(item)}</ul>
            </>
          ) : null}
          {preview.decreases.length ? (
            <>
              <h3 className="section-title">{preview.effectiveAt ? t('appStore.removingOn', { date: formatDate(preview.effectiveAt) }) : t('appStore.removingNow')}</h3>
              <ul>{preview.decreases.map(item)}</ul>
            </>
          ) : null}
          {preview.trialing ? (
            <Alert tone="info">{t('appStore.reviewTrial')}</Alert>
          ) : (
            <dl className="wxp-dl">
              <dt>{t('appStore.priceNow')}</dt>
              <dd className="wxp-tabular">{preview.beforeMinor !== null ? `${formatInr(preview.beforeMinor)} ${per}` : '—'}</dd>
              <dt>{t('appStore.priceAfter')}</dt>
              <dd className="wxp-tabular">{preview.nowMinor !== null ? `${formatInr(preview.nowMinor)} ${per}` : '—'}</dd>
              {preview.effectiveAt && preview.laterMinor !== preview.nowMinor ? (
                <>
                  <dt>{t('appStore.priceFrom', { date: formatDate(preview.effectiveAt) })}</dt>
                  <dd className="wxp-tabular">{preview.laterMinor !== null ? `${formatInr(preview.laterMinor)} ${per}` : '—'}</dd>
                </>
              ) : null}
              <dt>{t('appStore.chargeNow')}</dt>
              <dd className="wxp-tabular">
                {formatInr(preview.chargeMinor)}{' '}
                {preview.chargeMinor > 0 ? <span className="wxp-muted">{t('appStore.chargeNote', { pct: Math.round(preview.periodLeftBps / 100) })}</span> : null}
              </dd>
            </dl>
          )}
          <p className="wxp-muted">{t('appStore.reviewNote')}</p>
        </>
      ) : null}
    </Dialog>
  );
}
