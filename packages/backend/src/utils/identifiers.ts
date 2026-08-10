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
  /**
   * One row of `reviewer_relations` and one of `reviewer_principal_links`.
   *
   * Neither existed on Mongo: the relation was identified by its `_id` and the
   * principal link was an ELEMENT of an array inside the reviewer profile, so
   * neither had an id of its own. Both tables carry a surrogate text primary key,
   * so both need something to put in it.
   *
   * Prefixed like every other key in this map rather than a bare UUID, even
   * though neither id crosses an API boundary. The prefix earns its place in a
   * LOG: these two tables are read side by side during a draw, both carry a
   * `reviewer_id` and an `external_principal_id`, and an unprefixed opaque
   * identifier in a diagnostic is one nobody can attribute to a table without
   * going and querying for it.
   */
  reviewerRelation: 'rvr',
  reviewerPrincipalLink: 'rvl',
  assignment: 'asg',
  /** One sortition draw: its seed, its candidate snapshot and its outcome. */
  sortitionDraw: 'drw',
  review: 'rev',
  /**
   * One REVISION of a case's outcome, not one case (§9.9, Appendix B's `dec_`).
   *
   * An appeal produces a second decision id for the same case, and both ids stay
   * valid forever — the first names what was decided and later superseded, the
   * second names what replaced it. An id that meant "the decision of this case"
   * would have to be reused, which is the edit §9.9 forbids wearing a different
   * hat.
   */
  decision: 'dec',
  /**
   * One appeal (§9.8): the filing that superseded one revision and opened the
   * next. Never the revision itself, and never the decision that answers it —
   * both of those have their own ids, and an appeal that shared one would make
   * "which decision did this appeal produce" ambiguous the second time a case is
   * appealed.
   */
  appeal: 'apl',
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
