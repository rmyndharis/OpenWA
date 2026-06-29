import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import es from './locales/es.json';
import he from './locales/he.json';
import zhCN from './locales/zh-CN.json';
import zhHK from './locales/zh-HK.json';
import ar from './locales/ar.json';
import te from './locales/te.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import ptBR from './locales/pt-BR.json';

export const supportedLanguages = ['en', 'es', 'he', 'zh-CN', 'zh-HK', 'ar', 'te', 'fr', 'it', 'pt-BR'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const rtlLanguages: SupportedLanguage[] = ['he', 'ar'];

export const languageOptions: Array<{ value: SupportedLanguage; label: string; compactLabel: string }> = [
  { value: 'en', label: 'English', compactLabel: 'EN' },
  { value: 'es', label: 'Español', compactLabel: 'ES' },
  { value: 'he', label: 'עברית', compactLabel: 'עברית' },
  { value: 'zh-CN', label: '简体中文', compactLabel: '简中' },
  { value: 'zh-HK', label: '繁體中文', compactLabel: '繁中' },
  { value: 'ar', label: 'العربية', compactLabel: 'AR' },
  { value: 'te', label: 'తెలుగు', compactLabel: 'TE' },
  { value: 'fr', label: 'Français', compactLabel: 'FR' },
  { value: 'it', label: 'Italiano', compactLabel: 'IT' },
  { value: 'pt-BR', label: 'Português (Brasil)', compactLabel: 'PT' },
];

export function resolveSupportedLanguage(lang?: string): SupportedLanguage {
  const value = lang || 'en';
  const exact = supportedLanguages.find(supported => supported.toLowerCase() === value.toLowerCase());
  if (exact) return exact;

  const parts = value.toLowerCase().split('-');
  const base = parts[0];
  if (base === 'zh') {
    const subtags = new Set(parts.slice(1));
    if (subtags.has('hant') || subtags.has('hk') || subtags.has('mo') || subtags.has('tw')) return 'zh-HK';
    return 'zh-CN';
  }

  return supportedLanguages.find(supported => supported === base) ?? 'en';
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
      he: { translation: he },
      'zh-CN': { translation: zhCN },
      'zh-HK': { translation: zhHK },
      ar: { translation: ar },
      te: { translation: te },
      fr: { translation: fr },
      it: { translation: it },
      'pt-BR': { translation: ptBR },
    },
    fallbackLng: 'en',
    supportedLngs: supportedLanguages as unknown as string[],
    nonExplicitSupportedLngs: false,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'openwa_language',
      caches: ['localStorage'],
      convertDetectedLanguage: (lang: string) => resolveSupportedLanguage(lang),
    },
    react: { useSuspense: false },
  });

function applyDirection(lang: string) {
  const resolved = resolveSupportedLanguage(lang);
  const dir = rtlLanguages.includes(resolved) ? 'rtl' : 'ltr';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = resolved;
    document.documentElement.dir = dir;
  }
}

applyDirection(i18n.language);
i18n.on('languageChanged', applyDirection);

export default i18n;
