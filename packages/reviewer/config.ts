// Base URLs (prod first → env → fallback)
export const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

export type RuntimeLogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';
const VALID_LOG_LEVELS: readonly RuntimeLogLevel[] = [
  'debug',
  'info',
  'log',
  'warn',
  'error',
];
const configuredLogLevel = process.env.EXPO_PUBLIC_LOG_LEVEL;
export const LOG_LEVEL: RuntimeLogLevel | undefined =
  configuredLogLevel &&
  VALID_LOG_LEVELS.includes(configuredLogLevel as RuntimeLogLevel)
    ? (configuredLogLevel as RuntimeLogLevel)
    : undefined;
export const LOG_DEBUG_FILTER = process.env.EXPO_PUBLIC_LOG_DEBUG ?? '';

export const API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://api.crowdsource.oxy.so'
    : (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000');

export const OXY_BASE_URL =
  process.env.EXPO_PUBLIC_OXY_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.oxy.so' : 'http://localhost:3001');

/**
 * CrowdSource's registered Oxy OAuth client id (ApplicationCredential publicKey),
 * required by @oxyhq/services for the cross-app device sign-in flow.
 *
 * There is deliberately NO fallback: no client has been registered for
 * CrowdSource yet, so a hard-coded value here would be another product's
 * identity. Until `EXPO_PUBLIC_OXY_CLIENT_ID` is supplied, interactive sign-in
 * cannot start; cold boot and anonymous surfaces are unaffected.
 */
export const OXY_CLIENT_ID = process.env.EXPO_PUBLIC_OXY_CLIENT_ID;

/** Registered OAuth redirect surface for this web origin (exact match). */
export const OXY_AUTH_REDIRECT_URI =
  process.env.EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI ?? 'https://crowdsource.oxy.so';

/** Public web origin of the reviewer app. */
export const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL || 'https://crowdsource.oxy.so';
