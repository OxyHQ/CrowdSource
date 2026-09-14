/**
 * i18n configuration.
 *
 * Initialization is SYNCHRONOUS at import: the resources are bundled, so there is
 * nothing to await, and an async init from a layout effect is the shape that
 * deadlocks the app (a boot-mounted component suspends on `useTranslation`, the
 * root render never commits, the init effect never runs). `useSuspense: false`
 * removes the hazard a second time.
 *
 * Which language is active afterwards is not this module's decision: `OxyProvider`
 * resolves the signed-in account's primary locale (or, signed out, the device/guest
 * locale) and calls `setLanguage` below — wired as the `onChange` target in
 * `AppProviders` — whenever it changes. See ADR 0022
 * (`docs/adr/0022-app-i18n-follows-oxy-language.md` in `@oxy.so/services`).
 */

import i18n, { changeLanguage, init as i18nInit, use as i18nUse } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { logger } from '@/lib/logger';
import enUS from '@/locales/en.json';
import esES from '@/locales/es.json';

import { DEFAULT_LANGUAGE } from './constants';

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

/**
 * Switches language. The only supported `onChange` target for `OxyProvider`'s
 * `language` config — i18next's own `changeLanguage` resolves the active
 * `TFunction`, which does not satisfy the `Promise<void>` the config expects.
 */
export async function setLanguage(locale: string): Promise<void> {
  await changeLanguage(locale);
}

export default i18n;
