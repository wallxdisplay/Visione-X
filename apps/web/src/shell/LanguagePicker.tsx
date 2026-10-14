import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, setLanguage, type LanguageCode } from '../i18n';

/** UI language for this browser (English, Hindi, Marathi). */
export function LanguagePicker() {
  const { t, i18n } = useTranslation();
  return (
    <label className="language-picker" title={t('shell.language')}>
      <Languages size={16} aria-hidden />
      <span className="sr-only">{t('shell.language')}</span>
      <select value={i18n.language} onChange={(e) => void setLanguage(e.target.value as LanguageCode)}>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
