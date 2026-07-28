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
  outboxEvent: 'evt',
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
