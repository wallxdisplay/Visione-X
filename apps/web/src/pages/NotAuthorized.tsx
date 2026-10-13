import { EmptyState } from '@wallx-play/ui';
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

export function NotAuthorized() {
  const { t } = useTranslation();
  return (
    <div className="standalone">
      <section className="standalone__panel">
        <EmptyState
          icon={<ShieldAlert size={24} aria-hidden />}
          title={t('notAuthorized.title')}
          description={t('notAuthorized.description')}
          action={<Link to="/">{t('notFound.action')}</Link>}
        />
      </section>
    </div>
  );
}
