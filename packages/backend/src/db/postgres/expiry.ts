import type { ExpirySweepTarget } from '@oxy.so/db/expiry';

import { webhookAttempts } from './schema/webhooks';

/**
 * The retention deadlines this service keeps.
 *
 * `webhook_attempts` expires on `attempted_at`. Postgres has no TTL index, so
 * the deadline has to be swept — and a registry that nothing RUNS is the failure
 * this file exists to avoid: another Oxy service served expired rows for hours
 * while every code search for the retention logic found a correct-looking
 * declaration. The declaration is here; `startExpirySweeper` in
 * `db/postgres/sweeper.ts` is the caller, and `server.ts` is what starts it.
 *
 * Exactly one target, matching the exactly one TTL index in the backend. If a
 * later table gains a deadline it belongs here, beside its own reason.
 */

/** 90 days. */
export const WEBHOOK_ATTEMPT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export function expirySweepTargets(): ExpirySweepTarget[] {
  return [
    {
      table: webhookAttempts,
      column: webhookAttempts.attemptedAt,
      /**
       * The column holds when the attempt HAPPENED, not when it expires, so the
       * retention window is supplied here. `@crowdsource.you/core/outbox`'s targets pass 0
       * because their column is already a deadline — the difference is the
       * column's meaning, not a tuning choice.
       */
      retentionSeconds: WEBHOOK_ATTEMPT_RETENTION_SECONDS,
      reason:
        'A delivery attempt records a tenant server’s response body, redacted but not guaranteed clean; §13.6 caps that at 90 days.',
    },
  ];
}
