import { collection, orderBy, query } from 'firebase/firestore';
import { Card, PageHeader, StatusChip } from '@wallx-play/ui';
import { isScreenOnline, paths, type MemberDoc, type ScreenDoc, type SubscriptionDoc } from '@wallx-play/shared';
import { CheckCircle2, Circle, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSites } from '../../content/data';
import { db } from '../../lib/firebase';
import { daysLeft, formatDate, formatDateTime } from '../../lib/format';
import { useDoc, useQueryData } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';

interface Issue {
  key: string;
  tone: 'danger' | 'warning' | 'info';
  text: string;
  when?: number | null;
}

/** "What needs attention, and what should I do next?" — in about 30 seconds. */
export function Dashboard() {
  const { t } = useTranslation();
  const { orgId, org, entitlements, can } = useOrg();
  const sites = useSites(orgId);
  const screens = useQueryData<ScreenDoc>(`screens:${orgId}`, () => query(collection(db, paths.screens(orgId)), orderBy('name')));
  const members = useQueryData<MemberDoc>(can('member.view') ? `members:${orgId}` : null, () =>
    query(collection(db, paths.members(orgId))),
  );
  const subscription = useDoc<SubscriptionDoc>(can('billing.view') ? paths.orgSubscription(orgId) : null);
  const trialEnds = subscription.data?.status === 'trialing' ? subscription.data.trialEndsAt : null;

  const authorized = screens.data.filter((s) => s.status === 'authorized');
  const online = authorized.filter((s) => isScreenOnline(s));
  const offline = authorized.filter((s) => s.lastSeen && !isScreenOnline(s));

  const issues: Issue[] = [
    ...offline.map((s) => ({ key: `off-${s.id}`, tone: 'danger' as const, text: t('dashboard.issues.offline', { screen: s.name }), when: s.lastSeen })),
    ...screens.data
      .filter((s) => s.status === 'pending_authorization')
      .map((s) => ({ key: `pend-${s.id}`, tone: 'warning' as const, text: t('dashboard.issues.pending', { screen: s.name }) })),
    ...authorized
      .filter((s) => s.health?.errors.length)
      .map((s) => ({ key: `err-${s.id}`, tone: 'warning' as const, text: t('dashboard.issues.errors', { screen: s.name, count: s.health!.errors.length }), when: s.health!.reportedAt })),
    ...authorized
      .filter((s) => !s.publishedAt)
      .map((s) => ({ key: `pub-${s.id}`, tone: 'info' as const, text: t('dashboard.issues.unpublished', { screen: s.name }) })),
  ];
  const screenLimit = entitlements?.limits.screens;
  if (screenLimit && screens.data.length >= screenLimit) {
    issues.push({ key: 'limit', tone: 'warning', text: t('dashboard.issues.screenLimit', { limit: screenLimit }) });
  }

  const steps = [
    { done: true, label: t('dashboard.steps.approved') },
    { done: sites.data.length > 0, label: t('dashboard.steps.site'), to: '/sites' },
    { done: members.data.length > 1, label: t('dashboard.steps.team'), to: '/team' },
    { done: screens.data.length > 0, label: t('dashboard.steps.screen'), to: '/screens' },
    { done: authorized.some((s) => s.publishedAt), label: t('dashboard.steps.publish'), to: '/screens' },
  ];
  const setupDone = steps.every((s) => s.done);

  return (
    <>
      <PageHeader title={t('dashboard.title')} description={org?.name} />
      <div className="wxp-stat-row">
        <div className="wxp-stat">
          <div className="wxp-stat__label">{t('dashboard.totalScreens')}</div>
          <div className="wxp-stat__value">{screens.data.length}</div>
          <div className="wxp-muted">{t('dashboard.ofLimit', { limit: screenLimit ?? '∞' })}</div>
        </div>
        <div className="wxp-stat">
          <div className="wxp-stat__label">{t('dashboard.online')}</div>
          <div className="wxp-stat__value">{online.length}</div>
        </div>
        <div className={`wxp-stat${offline.length ? ' wxp-stat--alert' : ''}`}>
          <div className="wxp-stat__label">{t('dashboard.offline')}</div>
          <div className="wxp-stat__value">{offline.length}</div>
        </div>
        <div className="wxp-stat">
          <div className="wxp-stat__label">{t('dashboard.plan')}</div>
          <div className="wxp-stat__value" style={{ fontSize: 22 }}>
            {t(`plans.${entitlements?.planId ?? 'trial'}`, { defaultValue: entitlements?.planId })}
          </div>
          {trialEnds ? <div className="wxp-muted">{t('dashboard.trialEnds', { days: daysLeft(trialEnds), date: formatDate(trialEnds) })}</div> : null}
        </div>
      </div>

      <div className="wxp-stack">
        <Card title={t('dashboard.attention')}>
          {issues.length === 0 ? (
            <p className="wxp-muted" style={{ margin: 0 }}>
              {screens.data.length ? t('dashboard.allGood') : t('dashboard.noScreensYet')}
            </p>
          ) : (
            <ul className="attention">
              {issues.map((i) => (
                <li key={i.key}>
                  <TriangleAlert size={16} className={`attention__icon attention__icon--${i.tone}`} aria-hidden />
                  <Link to="/screens">{i.text}</Link>
                  {i.when ? <span className="wxp-muted">{formatDateTime(i.when)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {!setupDone ? (
          <Card title={t('dashboard.setupTitle')}>
            <ul className="checklist">
              {steps.map((s) => (
                <li key={s.label}>
                  {s.done ? (
                    <CheckCircle2 size={18} className="checklist__done" aria-hidden />
                  ) : (
                    <Circle size={18} className="checklist__todo" aria-hidden />
                  )}
                  <span>{s.to && !s.done ? <Link to={s.to}>{s.label}</Link> : s.label}</span>
                  {s.done ? <StatusChip tone="success">{t('common.done')}</StatusChip> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
