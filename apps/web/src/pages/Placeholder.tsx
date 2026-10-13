import { EmptyState, PageHeader } from '@wallx-play/ui';
import { Construction } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NavItem } from '../shell/nav';

/** Stand-in for modules not yet built; driven by the nav config so routes stay in one place. */
export function Placeholder({ item }: { item: NavItem }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t(item.labelKey)} />
      <div className="wxp-card">
        <EmptyState
          icon={<Construction size={24} aria-hidden />}
          title={t('placeholder.title', { phase: item.phase })}
          description={t('placeholder.description', { phase: item.phase })}
        />
      </div>
    </>
  );
}
