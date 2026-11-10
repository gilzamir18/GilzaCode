import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ptBR from './locales/pt-BR.json';
import en from './locales/en.json';

// Safe localStorage access — webviews may block it
function safeLocalStorage(fn) {
  try { return fn(); } catch (_) { return null; }
}

const savedLanguage = safeLocalStorage(() => localStorage.getItem('uiLanguage'));

// Detect OS/browser language manually, avoiding the LanguageDetector plugin
// which may throw in restricted webview environments
function detectLanguage() {
  if (savedLanguage) return savedLanguage;
  const nav = (navigator.language || navigator.languages?.[0] || 'en').toLowerCase();
  if (nav.startsWith('pt')) return 'pt-BR';
  return 'en';
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      'pt-BR': { translation: ptBR },
      pt: { translation: ptBR },
      en: { translation: en },
    },
    lng: detectLanguage(),
    fallbackLng: 'en',
    initImmediate: false,
    parseMissingKeyHandler: (key, defaultValue) => {
      if (typeof defaultValue === 'string' && defaultValue) return defaultValue;
      return key;
    },
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
