import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';
import enContent from './locales/en/content.json';
import enSensors from './locales/en/sensors.json';

// All UI strings live in locales/<lng>/*.json (merged into one namespace). Hindi (hi) and
// Marathi (mr) are added later by dropping in translated files; components must never contain
// hard-coded user-facing text.
void i18n.use(initReactI18next).init({
  resources: { en: { common: { ...en, ...enContent, ...enSensors } } },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: { escapeValue: false },
});

export default i18n;
