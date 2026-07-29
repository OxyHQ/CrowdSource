/**
 * The identity every reviewer query and cache entry is scoped to.
 *
 * Two failures this exists to prevent, both of which look like nothing is wrong.
 *
 * **The cold-boot race.** Device-first session restore is not instant — it can
 * take many seconds — and until it finishes `isAuthenticated: false` means
 * UNDETERMINED, not signed out. A query that fires on mount and is keyed on
 * nothing that changes runs once against an anonymous client, caches the
 * failure, and never recovers when the session lands. Keying on `key` and
 * gating on `canQuery` makes the arrival of a session a cache-key change, which
 * is what makes the fetch happen at the right moment instead of the first one.
 *
 * **Cross-account bleed.** A person can switch Oxy accounts without reloading.
 * An unscoped key would hand the previous reviewer's standing, training state
 * and review history to the next one.
 *
 * The key is PREFIXED (`user:<id>`) so it can never collide with the
 * `anonymous` sentinel, whatever shape an Oxy user id takes.
 *
 * The decisions live here as pure functions, with no imports, and the hook that
 * feeds them live auth state lives in `use-reviewer-viewer.ts`. The split is the
 * same one `query-keys.ts` makes and for the same reason: exercising the rule
 * that keeps one reviewer's data away from the next should not require a
 * runtime capable of mounting the whole Oxy SDK.
 */

export interface ReviewerViewer {
  /**
   * Stable cache key for the resolved identity, or `null` while cold boot has
   * not concluded. `null` is not "signed out" — it is "not known yet", and the
   * difference is the whole point of this module.
   */
  key: string | null;

  /**
   * Whether a bearer token is available for the private reviewer API right now.
   *
   * `isAuthenticated` alone is not enough: a session can be committed a moment
   * before its access token is, and a request sent in that window comes back
   * 401.
   */
  canQuery: boolean;
}

/** The auth facts the viewer is derived from. */
export interface ViewerAuthState {
  isAuthResolved: boolean;
  isAuthenticated: boolean;
  userId: string | null;
  canUsePrivateApi: boolean;
}

/**
 * Derives the viewer from auth state.
 *
 * Pure, and exported, because this is the decision that keeps one reviewer's
 * standing away from the next one. A privacy rule that can only be exercised by
 * rendering the app is a privacy rule nobody tests.
 */
export function resolveViewer({
  isAuthResolved,
  isAuthenticated,
  userId,
  canUsePrivateApi,
}: ViewerAuthState): ReviewerViewer {
  if (!isAuthResolved) {
    return { key: null, canQuery: false };
  }
  if (!isAuthenticated || userId === null) {
    return { key: 'anonymous', canQuery: false };
  }
  return { key: `user:${userId}`, canQuery: canUsePrivateApi };
}

/**
 * Whether moving from `previous` to `next` means another account's data is now
 * in memory and has to go.
 *
 * `null` on either side is "not known yet", never "changed": an unresolved cold
 * boot must not read as an account switch, or every page load would wipe the
 * cache it just filled.
 */
export function shouldDropPreviousViewer(previous: string | null, next: string | null): boolean {
  if (previous === null || next === null) {
    return false;
  }
  return previous !== next;
}

/**
 * Cache key used while the identity is still undetermined.
 *
 * Every query holding this key is disabled, so it never reaches the network. It
 * exists only because React Query requires a key even for a query that is not
 * allowed to run.
 */
export const UNRESOLVED_VIEWER_KEY = 'unresolved';
