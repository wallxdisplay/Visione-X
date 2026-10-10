import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';

// All UI strings live in locales/<lng>/*.json. Hindi (hi) and Marathi (mr) are added later by
// dropping in translated files; components must never contain hard-coded user-facing text.
void i18n.use(initReactI18next).init({
  resources: { en: { common: en } },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: { escapeValue: false },
});

export default i18n;
