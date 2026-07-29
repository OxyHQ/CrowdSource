import { randomUUID } from 'node:crypto';

/**
 * Public identifiers.
 *
 * §12.9 requires public ids to be ULID or UUID — never sequential. A sequential
 * id leaks how much traffic a tenant sends and lets a caller probe for
 * neighbouring records; the tenant filter would still refuse them, but the
 * probe itself is information a competitor should not get for free.
 *
 * The prefix is not decoration. It makes the type of a value obvious in a log
 * line, in a support conversation and in an error message, and it means a
 * credential id pasted where a report id belongs fails at the boundary instead
 * of matching nothing for reasons nobody can see.
 */

/** One prefix per public identifier kind. */
export const ID_PREFIX = {
  organization: 'org',
  application: 'app',
  /** Credential ids are the lookup half of a service token, hence a key prefix. */
  credential: 'csk',
  report: 'rpt',
  case: 'case',
  outboxEvent: 'evt',
  auditEvent: 'aud',
  webhookEndpoint: 'whe',
  /**
   * A LOGICAL delivery — one event to one endpoint, however many attempts it
   * takes. Its attempts carry their own ids so a support conversation about "the
   * third attempt" cannot be confused with one about the delivery itself.
   */
  webhookDelivery: 'whd',
  webhookAttempt: 'wha',
  /**
   * A reviewer's id INSIDE CrowdSource, distinct from their Oxy user id.
   *
   * The separation is the point. §9.1's blind review and §8.7's "reveals no ids
   * usable elsewhere" both fail the moment a case-adjacent record carries an
   * identifier that means something on another Oxy surface: an operator reading
   * an assignment would learn whose account it is, and a leaked draw record
   * would name real people. The mapping lives on the reviewer profile and
   * nowhere else.
   */
  reviewer: 'rvw',
  assignment: 'asg',
  /** One sortition draw: its seed, its candidate snapshot and its outcome. */
  sortitionDraw: 'drw',
  review: 'rev',
} as const;

export type PublicIdKind = keyof typeof ID_PREFIX;

/**
 * A fresh, non-sequential public id of the given kind.
 *
 * `randomUUID` is a CSPRNG draw, so ids carry no creation order and cannot be
 * walked. Dashes are stripped so the value is a single token in a URL, a header
 * and a service token alike.
 */
export function newPublicId(kind: PublicIdKind): string {
  return `${ID_PREFIX[kind]}_${randomUUID().replace(/-/g, '')}`;
}

/** True when `value` is a well-formed public id of the given kind. */
export function isPublicId(kind: PublicIdKind, value: string): boolean {
  return new RegExp(`^${ID_PREFIX[kind]}_[0-9a-f]{32}$`).test(value);
}
