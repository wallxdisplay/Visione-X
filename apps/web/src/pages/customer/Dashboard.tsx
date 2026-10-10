import { collection, query } from 'firebase/firestore';
import { Card, PageHeader, StatusChip } from '@visione-x/ui';
import { paths, type MemberDoc, type SiteDoc, type SubscriptionDoc } from '@visione-x/shared';
import { CheckCircle2, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { db } from '../../lib/firebase';
import { daysLeft, formatDate } from '../../lib/format';
import { useDoc, useQueryData } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';

export function Dashboard() {
  const { t } = useTranslation();
  const { orgId, org, entitlements, can } = useOrg();
  const sites = useQueryData<SiteDoc>(`sites:${orgId}`, () => query(collection(db, paths.sites(orgId))));
  const members = useQueryData<MemberDoc>(can('member.view') ? `members:${orgId}` : null, () =>
    query(collection(db, paths.members(orgId))),
  );
  const subscription = useDoc<SubscriptionDoc>(can('billing.view') ? paths.orgSubscription(orgId) : null);
  const trialEnds = subscription.data?.status === 'trialing' ? subscription.data.trialEndsAt : null;

  const steps = [
    { done: true, label: t('dashboard.steps.approved') },
    { done: sites.data.length > 0, label: t('dashboard.steps.site'), to: '/sites' },
    { done: members.data.length > 1, label: t('dashboard.steps.team'), to: '/team' },
    { done: false, label: t('dashboard.steps.screen'), note: t('dashboard.steps.screenNote') },
  ];

  return (
    <>
      <PageHeader title={t('dashboard.title')} description={org?.name} />
      <div className="vx-stat-row">
        <div className="vx-stat">
          <div className="vx-stat__label">{t('dashboard.plan')}</div>
          <div className="vx-stat__value" style={{ fontSize: 22 }}>
            {t(`plans.${entitlements?.planId ?? 'trial'}`, { defaultValue: entitlements?.planId })}
          </div>
          {trialEnds ? (
            <div className="vx-muted">
              {t('dashboard.trialEnds', { days: daysLeft(trialEnds), date: formatDate(trialEnds) })}
            </div>
          ) : null}
        </div>
        <div className="vx-stat">
          <div className="vx-stat__label">{t('dashboard.screenLimit')}</div>
          <div className="vx-stat__value">{entitlements?.limits.screens ?? '∞'}</div>
        </div>
        <div className="vx-stat">
          <div className="vx-stat__label">{t('dashboard.userLimit')}</div>
          <div className="vx-stat__value">{entitlements?.limits.users ?? '∞'}</div>
        </div>
        <div className="vx-stat">
          <div className="vx-stat__label">{t('dashboard.sites')}</div>
          <div className="vx-stat__value">{sites.data.length}</div>
        </div>
      </div>

      <Card title={t('dashboard.setupTitle')}>
        <ul className="checklist">
          {steps.map((s) => (
            <li key={s.label}>
              {s.done ? (
                <CheckCircle2 size={18} className="checklist__done" aria-hidden />
              ) : (
                <Circle size={18} className="checklist__todo" aria-hidden />
              )}
              <span>
                {s.to && !s.done ? <Link to={s.to}>{s.label}</Link> : s.label}
                {s.note ? <span className="vx-muted"> — {s.note}</span> : null}
              </span>
              {s.done ? <StatusChip tone="success">{t('common.done')}</StatusChip> : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
