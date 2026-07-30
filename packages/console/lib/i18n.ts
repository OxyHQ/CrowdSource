/**
 * i18n configuration.
 *
 * Initialization is SYNCHRONOUS at import: the resources are bundled, so there is
 * nothing to await, and an async init from a layout effect is the shape that
 * deadlocks the app (a boot-mounted component suspends on `useTranslation`, the
 * root render never commits, the init effect never runs). `useSuspense: false`
 * removes the hazard a second time.
 *
 * The stored language preference resolves afterwards and switches the language
 * when it arrives.
 */

import i18n, { changeLanguage, init as i18nInit, use as i18nUse } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { logger } from '@/lib/logger';
import enUS from '@/locales/en.json';
import esES from '@/locales/es.json';
import { Storage } from '@/utils/storage';

import { DEFAULT_LANGUAGE, STORAGE_KEYS } from './constants';

const i18nResources = {
  'en-US': { translation: enUS },
  'es-ES': { translation: esES },
} as const;

i18nUse(initReactI18next);
i18nInit({
  resources: i18nResources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
}).catch((error: unknown) => {
  logger.error('i18n initialization failed', { error });
});

/** Applies the persisted language preference once storage answers. */
export async function applySavedLanguage(): Promise<void> {
  const savedLanguage = await Storage.get<string>(STORAGE_KEYS.LANGUAGE_PREFERENCE);
  if (savedLanguage && savedLanguage !== i18n.language) {
    await changeLanguage(savedLanguage);
  }
}

applySavedLanguage().catch((error: unknown) => {
  logger.warn('Failed to apply the saved language preference', { error });
});

export default i18n;
