import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';
import enContent from './locales/en/content.json';
import enSensors from './locales/en/sensors.json';
import enBilling from './locales/en/billing.json';
import enIntegrations from './locales/en/integrations.json';
import enReports from './locales/en/reports.json';
import enAnalytics from './locales/en/analytics.json';
import enApi from './locales/en/api.json';
import enSync from './locales/en/sync.json';
import enPartner from './locales/en/partner.json';

// All UI strings live in locales/<lng>/*.json (merged into one namespace); components must never
// contain hard-coded user-facing text. English ships in the main bundle; Hindi and Marathi load
// when chosen. Missing keys fall back to English. What screens show (clock, weather, charts) is
// not translated here: it follows the player, which renders in English.
export const LANGUAGES = [
  { code: 'en', label: 'English', locale: 'en-IN' },
  { code: 'hi', label: 'हिन्दी', locale: 'hi-IN' },
  // Latin digits, like counts and amounts elsewhere in the app (mr-IN defaults to Devanagari digits).
  { code: 'mr', label: 'मराठी', locale: 'mr-IN-u-nu-latn' },
] as const;
export type LanguageCode = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'wxp.language';

const loaders: Record<Exclude<LanguageCode, 'en'>, () => Promise<Array<{ default: object }>>> = {
  hi: () =>
    Promise.all([
      import('./locales/hi/common.json'),
      import('./locales/hi/content.json'),
      import('./locales/hi/sensors.json'),
      import('./locales/hi/billing.json'),
      import('./locales/hi/integrations.json'),
      import('./locales/hi/reports.json'),
      import('./locales/hi/analytics.json'),
      import('./locales/hi/api.json'),
      import('./locales/hi/sync.json'),
      import('./locales/hi/partner.json'),
    ]),
  mr: () =>
    Promise.all([
      import('./locales/mr/common.json'),
      import('./locales/mr/content.json'),
      import('./locales/mr/sensors.json'),
      import('./locales/mr/billing.json'),
      import('./locales/mr/integrations.json'),
      import('./locales/mr/reports.json'),
      import('./locales/mr/analytics.json'),
      import('./locales/mr/api.json'),
      import('./locales/mr/sync.json'),
      import('./locales/mr/partner.json'),
    ]),
};

/** BCP 47 locale for dates and numbers in the current language. */
export function currentLocale(): string {
  return LANGUAGES.find((l) => l.code === i18n.language)?.locale ?? 'en-IN';
}

function storedLanguage(): LanguageCode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some((l) => l.code === v) ? (v as LanguageCode) : 'en';
  } catch {
    return 'en';
  }
}

/** Switches the UI language (loading it first) and remembers the choice in this browser. */
export async function setLanguage(code: LanguageCode): Promise<void> {
  // Remember first, so leaving the page while the language loads keeps the choice.
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* storage unavailable: the choice lasts for this page view */
  }
  if (code !== 'en' && !i18n.hasResourceBundle(code, 'common')) {
    const parts = await loaders[code]();
    i18n.addResourceBundle(code, 'common', Object.assign({}, ...parts.map((p) => p.default)), true, true);
  }
  await i18n.changeLanguage(code);
  document.documentElement.lang = code;
}

void i18n.use(initReactI18next).init({
  resources: { en: { common: { ...en, ...enContent, ...enSensors, ...enBilling, ...enIntegrations, ...enReports, ...enAnalytics, ...enApi, ...enSync, ...enPartner } } },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: { escapeValue: false },
});

// {{value, date}} in strings: a medium date in the current language (12 Oct 2026 / 12 अक्टू॰ 2026).
i18n.services.formatter?.add('date', (value: unknown) =>
  typeof value === 'number' ? new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium' }).format(value) : String(value),
);

const initial = storedLanguage();
if (initial !== 'en') void setLanguage(initial);

export default i18n;
