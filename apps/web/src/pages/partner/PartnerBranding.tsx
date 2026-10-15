import { EmptyState, PageHeader, Spinner } from '@wallx-play/ui';
import { paths, type AccountDoc } from '@wallx-play/shared';
import { Palette } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BrandEditor } from '../../brand/BrandEditor';
import { useDoc } from '../../lib/hooks';
import { usePartner } from '../../partner/PartnerProvider';

/** Partner portal → Branding: the reseller's brand, shown to all its customers and their screens. */
export function PartnerBranding() {
  const { t } = useTranslation();
  const { accountId, role } = usePartner();
  const account = useDoc<AccountDoc>(paths.account(accountId));
  if (account.loading) return <Spinner label={t('common.loading')} />;
  const a = account.data;
  return (
    <>
      <PageHeader title={t('partner.branding.title')} description={t('partner.branding.description')} />
      {!a?.whiteLabel ? (
        <div className="wxp-card">
          <EmptyState icon={<Palette size={24} aria-hidden />} title={t('partner.branding.offTitle')} description={t('partner.branding.offBody')} />
        </div>
      ) : role !== 'owner' ? (
        <p className="wxp-muted">{t('partner.branding.ownersOnly')}</p>
      ) : (
        <div className="wxp-card">
          <BrandEditor key={a.brand?.updatedAt ?? 0} target={{ kind: 'account', accountId }} current={a.brand ?? null} />
          {a.brand?.domains.length ? <p className="wxp-muted">{t('brand.domains', { list: a.brand.domains.join(', ') })}</p> : <p className="wxp-muted">{t('brand.domainHint')}</p>}
        </div>
      )}
    </>
  );
}
