/**
 * How a code becomes a colour, and what a missing figure looks like.
 *
 * Pure functions, in their own module, because two of the decisions here are
 * product invariants rather than styling:
 *
 * 1. **`inconclusive` is never drawn as `no_violation`.** A jury that reviewed the
 *    case and did not reach the threshold has said something different from a jury
 *    that agreed nothing was wrong. Absence of consensus is neither guilt nor
 *    innocence, so it gets its own tone — and `__tests__/presentation.test.ts`
 *    asserts the two are distinct, so a palette tidy-up cannot quietly merge them.
 * 2. **An absent figure is drawn as absent.** `evidenceIntegrity` and its
 *    siblings are `null` because nothing measures them yet. Rendering that as `0`
 *    would report the worst possible score for a signal that has never been taken.
 *
 * A `Tone` is a semantic name, not a colour. `StatusPill` maps it to Bloom tokens
 * via NativeWind classes; nothing here knows a hex value.
 */

import type {
  ApplicationStanding,
  CaseStatus,
  CredentialStatus,
  DecisionOutcome,
  DeliveryStatus,
  WebhookEndpointStatus,
} from './types';

/**
 * The tones a pill can take.
 *
 * `caution` and `danger` are deliberately separate from each other and from
 * `neutral`: a case awaiting review is not a problem, a delivery retrying is a
 * problem that may still resolve itself, and a dead-lettered delivery is one that
 * will not.
 */
export type Tone = 'neutral' | 'info' | 'positive' | 'caution' | 'danger' | 'unresolved';

/**
 * The em dash every absent value renders as.
 *
 * One constant so an absence looks the same in a table cell, a key/value row and
 * a metrics tile. A blank cell reads as a layout bug; a zero reads as a
 * measurement.
 */
export const ABSENT = '—';

/** Formats a nullable figure, never coercing an absence into a number. */
export function formatOptionalNumber(
  value: number | null,
  format: (value: number) => string,
): string {
  return value === null ? ABSENT : format(value);
}

/** Formats a nullable string, never rendering an empty cell. */
export function formatOptionalText(value: string | null): string {
  return value === null || value === '' ? ABSENT : value;
}

/**
 * A 0..1 figure as a percentage.
 *
 * Whole percent: the difference between 66% and 66.7% agreement changes nothing an
 * operator would do, and a decimal in every cell of a table costs the column its
 * scannability.
 */
export function formatRatio(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function standingTone(standing: ApplicationStanding): Tone {
  switch (standing) {
    case 'trusted':
      return 'positive';
    case 'restricted':
      return 'danger';
    case 'sandbox':
      // Not a warning. Every application starts here (§11.13) and plenty stay
      // here happily; colouring it as a fault would make a normal state look like
      // an incident on every row of the table.
      return 'info';
  }
}

/**
 * The outcome tones.
 *
 * `inconclusive` takes `unresolved` — its own tone, shared with nothing. Compare
 * `no_violation`, which is `positive` because the jury reached a conclusion, and
 * `insufficient_context`, which is `caution` because the case can be re-reviewed
 * with more context. Merging any two of these three would state something the
 * jury did not.
 */
export function outcomeTone(outcome: DecisionOutcome): Tone {
  switch (outcome) {
    case 'violation':
      return 'danger';
    case 'no_violation':
      return 'positive';
    case 'inconclusive':
      return 'unresolved';
    case 'insufficient_context':
      return 'caution';
    case 'content_unavailable':
    case 'duplicate':
      return 'neutral';
    case 'escalated':
      return 'info';
  }
}

export function caseStatusTone(status: CaseStatus): Tone {
  switch (status) {
    case 'decided':
      return 'positive';
    case 'escalated':
    case 'appealed':
      return 'caution';
    case 'received':
    case 'triaged':
    case 'awaiting_review':
    case 'under_review':
    case 'awaiting_consensus':
      return 'info';
    case 'superseded':
    case 'closed':
      return 'neutral';
  }
}

export function deliveryStatusTone(status: DeliveryStatus): Tone {
  switch (status) {
    case 'succeeded':
      return 'positive';
    case 'dead_letter':
      return 'danger';
    case 'delivering':
      return 'info';
    case 'pending':
      return 'caution';
  }
}

export function endpointStatusTone(status: WebhookEndpointStatus): Tone {
  return status === 'active' ? 'positive' : 'danger';
}

export function credentialStatusTone(status: CredentialStatus): Tone {
  return status === 'active' ? 'positive' : 'neutral';
}

/**
 * Whether an endpoint's delivery health is worth an operator's attention.
 *
 * A single dead letter is the signal — §10.9 promises the tenant an alert, and an
 * endpoint that has stopped receiving one event type is exactly the fault that
 * hides behind a mostly-green success count.
 */
export function endpointNeedsAttention(health: { deadLetter: number }): boolean {
  return health.deadLetter > 0;
}
