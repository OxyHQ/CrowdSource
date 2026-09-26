/**
 * What an erased person's id is replaced with, where a row is kept.
 *
 * `erased-` rather than Mention's `erased:` because several of these columns
 * are principal ids that leave this service again (a community note's
 * `authorPrincipalId` rides on a webhook) and must still satisfy the
 * contracts' identifier grammar, which has no `:`. One spelling everywhere, so
 * an operator greps for one prefix.
 *
 * Nothing about the person is derivable from either value: the constant names
 * nobody, and the per-row form names the ROW, whose id is a random public id.
 */
export const ERASED_PREFIX = 'erased-';

/** For a column with no uniqueness to keep: an audit actor, an inviter. */
export const ERASED_ACCOUNT = `${ERASED_PREFIX}account`;

/**
 * For a column that is part of a unique key (one reviewer profile per Oxy
 * account), so two erased people never collide on one sentinel.
 */
export function erasedRowIdentity(rowId: string): string {
  return `${ERASED_PREFIX}${rowId}`;
}
