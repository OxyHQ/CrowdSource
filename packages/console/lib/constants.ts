/**
 * Application-wide constants.
 */

export const STORAGE_KEYS = {
  LANGUAGE_PREFERENCE: 'user_language_preference',
} as const;

export const DEFAULT_LANGUAGE = 'en-US';

export const SUPPORTED_LANGUAGES = ['en-US', 'es-ES'] as const;

/**
 * How long a screen waits for the API before giving up.
 *
 * A request that has not answered by now is not going to, and a screen stuck on
 * a skeleton is strictly worse than one that says what is wrong: the console's
 * whole job is telling an integrator the state of their integration.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Usage window the overview asks for, in days.
 *
 * The API accepts 1..90 and defaults to 30. Naming it here rather than passing
 * nothing keeps the daily chart's span and the copy that describes it in one
 * place — a mismatch between the two is the kind of thing nobody reports.
 */
export const USAGE_WINDOW_DAYS = 30;

/**
 * Default overlap for a webhook secret rotation, in seconds (1 hour).
 *
 * The API accepts 0..604800. The point of an overlap is that an integrator can
 * deploy the new secret while deliveries are still signed with the old one, so
 * the default has to be long enough to ship a change and short enough that a
 * leaked secret is not honoured for a week.
 */
export const DEFAULT_SECRET_OVERLAP_SECONDS = 3600;
