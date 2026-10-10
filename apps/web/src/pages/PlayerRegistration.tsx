import { useTranslation } from 'react-i18next';

export function PlayerRegistration() {
  const { t } = useTranslation();
  return (
    <div className="standalone">
      <section className="standalone__panel">
        <h1 style={{ fontSize: 26, marginBottom: 8 }}>{t('player.title')}</h1>
        <p style={{ color: 'var(--color-ink-secondary)' }}>{t('player.description')}</p>
        <ol>
          <li>{t('player.step1')}</li>
          <li>{t('player.step2')}</li>
          <li>{t('player.step3')}</li>
          <li>{t('player.step4')}</li>
        </ol>
      </section>
    </div>
  );
}
