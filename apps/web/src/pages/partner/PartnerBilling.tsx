import { collection, orderBy, query } from 'firebase/firestore';
import { Alert, PageHeader, Spinner, StatusChip } from '@wallx-play/ui';
import { ACCOUNT_GRACE_DAYS, formatInr, paths, type AccountPaymentDoc, type PartnerOverview } from '@wallx-play/shared';
import { useTranslation } from 'react-i18next';
import { db } from '../../lib/firebase';
import { formatDate } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { usePartner } from '../../partner/PartnerProvider';
import './partner.css';

const DAY = 86_400_000;
const TONE = { active: 'success', past_due: 'warning', restricted: 'danger', none: 'neutral' } as const;

/** The reseller's own standing with WallX, shown at the top of the portal pages. */
export function AccountStanding({ overview }: { overview: PartnerOverview }) {
  const { t } = useTranslation();
  const a = overview.account;
  if (a.billingStatus === 'active') return null;
  const tone = a.billingStatus === 'past_due' ? 'warning' : a.billingStatus === 'restricted' ? 'danger' : 'info';
  return (
    <Alert tone={tone}>
      {t(`partner.standing.${a.billingStatus}`, { date: formatDate(a.paidThrough ? a.paidThrough + ACCOUNT_GRACE_DAYS * DAY : null) })}
    </Alert>
  );
}

/** Partner portal → Billing: dealer prices, what the reseller pays per month, and payments to WallX. */
export function PartnerBilling() {
  const { t } = useTranslation();
  const { accountId, overview, overviewError } = usePartner();
  const payments = useQueryData<AccountPaymentDoc>(`accountPayments:${accountId}`, () => query(collection(db, paths.accountPayments(accountId)), orderBy('paidAt', 'desc')));

  if (!overview) return overviewError ? <Alert tone="danger">{overviewError}</Alert> : <Spinner label={t('common.loading')} />;
  const a = overview.account;
  const billed = overview.customers.filter((c) => c.resellerBilled && !c.trialing);
  const trials = overview.customers.filter((c) => c.resellerBilled && c.trialing);

  return (
    <>
      <PageHeader title={t('partner.billing.title')} description={t('partner.billing.description')} />
      <AccountStanding overview={overview} />
      <div className="partner-stats">
        <div className="partner-stat">
          <span className="wxp-muted">{t('partner.billing.status')}</span>
          <StatusChip tone={TONE[a.billingStatus]}>{t(`partner.billing.statuses.${a.billingStatus}`)}</StatusChip>
        </div>
        <div className="partner-stat">
          <span className="wxp-muted">{t('partner.billing.paidThrough')}</span>
          <strong>{formatDate(a.paidThrough)}</strong>
        </div>
        <div className="partner-stat">
          <span className="wxp-muted">{t('partner.billing.monthly')}</span>
          <strong className="wxp-tabular">{overview.monthlyTotalMinor === null ? t('partner.priceToAgree') : formatInr(overview.monthlyTotalMinor)}</strong>
          <span className="wxp-muted">{t('partner.billing.exGst')}</span>
        </div>
      </div>
      <p className="wxp-muted">{t('partner.billing.howToPay')}</p>

      <h2 className="section-title">{t('partner.billing.prices')}</h2>
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('partner.billing.plan')}</th>
              <th>{t('partner.billing.listPrice')}</th>
              <th>{t('partner.billing.dealerPrice')}</th>
            </tr>
          </thead>
          <tbody>
            {overview.plans.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="wxp-tabular">{p.listPriceMinor === null ? '—' : formatInr(p.listPriceMinor)}</td>
                <td className="wxp-tabular">
                  <strong>{p.dealerPriceMinor === null ? t('partner.priceToAgree') : formatInr(p.dealerPriceMinor)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="wxp-muted">{t('partner.billing.perScreen')}</p>

      <h2 className="section-title">{t('partner.billing.lines')}</h2>
      {billed.length ? (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('partner.customers.name')}</th>
                <th>{t('partner.customers.plan')}</th>
                <th>{t('partner.billing.screens')}</th>
                <th>{t('partner.billing.dealerPrice')}</th>
                <th>{t('partner.customers.monthlyCol')}</th>
              </tr>
            </thead>
            <tbody>
              {billed.map((c) => (
                <tr key={c.orgId}>
                  <td>{c.name}</td>
                  <td>{c.planName}</td>
                  <td className="wxp-tabular">{c.quantity}</td>
                  <td className="wxp-tabular">{c.dealerPriceMinor === null ? t('partner.priceToAgree') : formatInr(c.dealerPriceMinor)}</td>
                  <td className="wxp-tabular">{c.monthlyMinor === null ? t('partner.priceToAgree') : formatInr(c.monthlyMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="wxp-muted">{t('partner.billing.noLines')}</p>
      )}
      {trials.length ? <p className="wxp-muted">{t('partner.billing.trials', { count: trials.length })}</p> : null}

      <h2 className="section-title">{t('partner.billing.payments')}</h2>
      {payments.data.length ? (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('partner.billing.paidOn')}</th>
                <th>{t('partner.billing.amount')}</th>
                <th>{t('partner.billing.covers')}</th>
                <th>{t('partner.billing.reference')}</th>
              </tr>
            </thead>
            <tbody>
              {payments.data.map((p) => (
                <tr key={p.id}>
                  <td>{formatDate(p.paidAt)}</td>
                  <td className="wxp-tabular">
                    {formatInr(p.amountMinor)} {p.voided ? <StatusChip tone="neutral">{t('billing.voided')}</StatusChip> : null}
                  </td>
                  <td>
                    {formatDate(p.periodStart)} – {formatDate(p.periodEnd)}
                  </td>
                  <td>
                    {p.reference}
                    {p.externalInvoiceNo ? <div className="wxp-muted">{t('partner.billing.invoice', { no: p.externalInvoiceNo })}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="wxp-muted">{t('partner.billing.noPayments')}</p>
      )}
    </>
  );
}
