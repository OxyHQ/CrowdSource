import { createHash, randomBytes } from 'node:crypto';
import { verifySecret } from '@oxyhq/core/server';

/**
 * The assignment token of §8.7.
 *
 * "The token only authorises that case and does not reveal ids usable in other
 * endpoints." Both halves are structural here:
 *
 *  - It authorises ONE case, because it is checked against one assignment row
 *    and nothing else in the system accepts it.
 *  - It reveals nothing, because it is opaque random bytes. It carries no case
 *    id, no reviewer id and no application id, so a token pasted into a support
 *    ticket, a log line or a screenshot leaks no identifier anybody can use.
 *
 * Only the hash is stored. A database dump therefore cannot be turned into
 * working access to a case, which matters more here than for an ordinary session
 * token: the thing behind it is reported material about a real person.
 *
 * The comparison is `verifySecret` — constant time, from the shared SDK — and
 * never `!==`, which short-circuits on the first differing byte and leaks the
 * value one byte at a time.
 */

/** 48 bytes of CSPRNG output, base64url — 384 bits, no padding, URL-safe. */
const TOKEN_BYTES = 48;

export interface MintedAssignmentToken {
  /** Returned to the reviewer exactly once, and never stored. */
  readonly token: string;
  /** What the assignment row keeps. */
  readonly tokenHash: string;
}

export function mintAssignmentToken(): MintedAssignmentToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: assignmentTokenHash(token) };
}

export function assignmentTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compared against when no token was presented, so a missing token costs the
 * same as a wrong one. The value is the hash of a string no `randomBytes` draw
 * produces.
 */
const ABSENT_TOKEN_HASH = createHash('sha256')
  .update('crowdsource:no-such-assignment-token', 'utf8')
  .digest('hex');

/** True when `token` is the live token of an assignment holding `storedHash`. */
export function assignmentTokenMatches(token: string | null, storedHash: string): boolean {
  if (token === null || token.length === 0) {
    verifySecret(ABSENT_TOKEN_HASH, ABSENT_TOKEN_HASH);
    return false;
  }
  return verifySecret(assignmentTokenHash(token), storedHash);
}
