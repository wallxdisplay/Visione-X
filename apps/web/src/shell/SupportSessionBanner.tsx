import { LifeBuoy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../lib/format';
import { useOrg } from '../org/OrgProvider';

/** Reminds WallX staff that they are inside a customer's organization through support access. */
export function SupportSessionBanner() {
  const { t } = useTranslation();
  const { member, org } = useOrg();
  if (!member?.support) return null;
  return (
    <div className="billing-banner billing-banner--warning" role="status">
      <LifeBuoy size={18} aria-hidden />
      <span>{t('supportAccess.session', { org: org?.name ?? '', until: formatDateTime(member.support.expiresAt) })}</span>
    </div>
  );
}
