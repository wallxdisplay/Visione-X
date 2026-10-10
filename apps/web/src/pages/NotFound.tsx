import { EmptyState } from '@visione-x/ui';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="standalone">
      <section className="standalone__panel">
        <EmptyState
          title={t('notFound.title')}
          description={t('notFound.description')}
          action={<Link to="/">{t('notFound.action')}</Link>}
        />
      </section>
    </div>
  );
}
