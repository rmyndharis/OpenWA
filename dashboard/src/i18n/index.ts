import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import he from './locales/he.json';
import ar from './locales/ar.json';

export const supportedLanguages = ['en', 'he', 'ar'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const rtlLanguages: SupportedLanguage[] = ['he', 'ar'];

export interface LanguageOption {
  code: SupportedLanguage;
  label: string;
  short: string;
}

export const languageOptions: LanguageOption[] = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'he', label: 'עברית', short: 'HE' },
  { code: 'ar', label: 'العربية', short: 'AR' },
];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      he: { translation: he },
      ar: { translation: ar },
    },
    fallbackLng: 'en',
    supportedLngs: supportedLanguages as unknown as string[],
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'openwa_language',
      caches: ['localStorage'],
    },
    react: { useSuspense: false },
  });

function applyDirection(lang: string) {
  const base = (lang || 'en').split('-')[0] as SupportedLanguage;
  const dir = rtlLanguages.includes(base) ? 'rtl' : 'ltr';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = base;
    document.documentElement.dir = dir;
  }
}

applyDirection(i18n.language);
i18n.on('languageChanged', applyDirection);

export default i18n;
