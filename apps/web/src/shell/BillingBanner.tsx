import { BILLING_GRACE_DAYS, TRIAL_REMINDER_DAYS } from '@wallx-play/shared';
import { CreditCard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDate } from '../lib/format';
import { useOrg } from '../org/OrgProvider';

const DAY = 86_400_000;

/** Subscription notice for every member: trial ending, payment overdue, or restricted. */
export function BillingBanner() {
  const { t } = useTranslation();
  const { org, can } = useOrg();
  const b = org?.billing;
  if (!b) return null;

  let tone: 'danger' | 'warning' | 'info' | null = null;
  let text = '';
  if (b.restricted) {
    tone = 'danger';
    text = t(b.status === 'cancelled' ? 'billingBanner.cancelled' : 'billingBanner.restricted');
  } else if (b.status === 'past_due' && b.currentPeriodEnd) {
    tone = 'warning';
    text = t('billingBanner.pastDue', { date: formatDate(b.currentPeriodEnd + BILLING_GRACE_DAYS * DAY) });
  } else if (b.status === 'trialing' && b.trialEndsAt && b.trialEndsAt - Date.now() < TRIAL_REMINDER_DAYS * DAY) {
    tone = 'info';
    text = t('billingBanner.trialEnding', { date: formatDate(b.trialEndsAt) });
  }
  if (!tone) return null;

  return (
    <div className={`billing-banner billing-banner--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <CreditCard size={18} aria-hidden />
      <span>{text}</span>
      {can('billing.view') ? <Link to="/billing">{t('billingBanner.view')}</Link> : null}
    </div>
  );
}
