/**
 * Idempotency by event id (§10.8: "store the processed event id").
 *
 * A delivery is retried on the schedule in §10.9 — six times over 24 hours —
 * and a retry can also happen because the receiver's 2xx was lost rather than
 * because it failed. So the same event WILL arrive twice at a healthy receiver,
 * and "did I already do this?" is the only thing standing between that and a
 * piece of content being removed twice or a user being suspended twice.
 *
 * The interface is claim/release rather than a "seen?" check, because the
 * obvious design is wrong in a way that is hard to see. Recording the id BEFORE
 * the handler runs makes a handler failure permanent: every retry is deduped
 * away and the work is lost silently, which is the worst possible outcome for a
 * moderation decision. Recording it AFTER lets two concurrent deliveries of the
 * same event both run. Claiming before and releasing on failure gets both: one
 * in flight, and a failure still retryable.
 */

/** The retry schedule of §10.9 ends at 24 hours; a claim outlives it. */
const DEFAULT_TTL_MS = 25 * 60 * 60 * 1_000;

const DEFAULT_MAX_ENTRIES = 10_000;

export interface ProcessedEventStore {
  /** True when this call took the claim; false when the event is already held. */
  claim(eventId: string): boolean | Promise<boolean>;
  /** Gives the claim back so a redelivery can be processed. */
  release(eventId: string): void | Promise<void>;
}

export interface MemoryProcessedEventStoreOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

/**
 * The default store: an in-process map with a TTL.
 *
 * **Per process.** Two instances behind a load balancer each keep their own,
 * so a redelivery that lands on the other instance is NOT deduped. That is
 * usually fine — the handlers a receiver should be writing are idempotent
 * anyway, because §7.6 makes the application responsible for recording what it
 * did about a decision — but an application whose enforcement is not idempotent
 * must pass a shared store (Redis, its own database) instead. Saying so here is
 * the point: a dedupe that silently only works on one instance is exactly the
 * kind of thing that looks correct in staging.
 *
 * There is no timer. Expiry is evaluated on read and the map is pruned on
 * insert, so nothing here keeps a Node event loop alive — a module-level
 * `setInterval` in a library is how a consumer's test run stops exiting.
 */
export function memoryProcessedEventStore(
  options: MemoryProcessedEventStoreOptions = {},
): ProcessedEventStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const claims = new Map<string, number>();

  const prune = (now: number): void => {
    for (const [eventId, expiresAt] of claims) {
      if (expiresAt <= now) claims.delete(eventId);
    }
    // Insertion-ordered, so the oldest claims go first once the cap is hit.
    while (claims.size >= maxEntries) {
      const oldest = claims.keys().next();
      if (oldest.done === true) break;
      claims.delete(oldest.value);
    }
  };

  return {
    claim(eventId: string): boolean {
      const now = Date.now();
      const held = claims.get(eventId);
      if (held !== undefined && held > now) return false;

      prune(now);
      claims.set(eventId, now + ttlMs);
      return true;
    },
    release(eventId: string): void {
      claims.delete(eventId);
    },
  };
}
