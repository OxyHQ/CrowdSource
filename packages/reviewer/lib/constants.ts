/**
 * Application-wide constants.
 */

export const STORAGE_KEYS = {
  LANGUAGE_PREFERENCE: 'user_language_preference',
} as const;

export const DEFAULT_LANGUAGE = 'en-US';

export const SUPPORTED_LANGUAGES = ['en-US', 'es-ES', 'it-IT'] as const;
