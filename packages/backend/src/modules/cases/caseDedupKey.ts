import { createHash } from 'node:crypto';

/**
 * The case deduplication key (§7.3).
 *
 *     caseDedupKey = SHA256(
 *       applicationId + ":" +
 *       subjectExternalId + ":" +
 *       contentEnvelopeHash + ":" +
 *       applicationPolicyVersion
 *     )
 *
 * Reproduced from the plan verbatim, including the separator, because the value
 * is a stable identity for "this version of this object, under this policy, in
 * this application" — it is what cross-application incident correlation will
 * compare later, so it has to be derivable by anything that knows the four
 * components rather than being an implementation detail of this service.
 *
 * The `:` separator is only unambiguous because none of the four components can
 * contain one: `@oxyhq/crowdsource-contracts` excludes `:` from every identifier
 * schema for exactly this reason, the content hash is `sha256:<hex>` with a
 * single fixed-position colon, and `policyVersionToken` below composes its two
 * halves with `@`. Without that, two different tuples could flatten to one
 * string and merge two unrelated cases.
 *
 * **This value is not what ENFORCES deduplication.** The unique compound index
 * on `applicationId + externalSubjectId + contentHash + policyVersion` is (§12.7,
 * `case.collection.ts`). The difference matters: a hash is a lossy projection,
 * and a collision in it would merge two genuinely unrelated cases into one
 * expedient — which under "one penalty per incident" means one of the two
 * incidents silently disappears. The compound index cannot do that. So the key
 * is stored and indexed for correlation and lookup, and the tuple is what the
 * database refuses to duplicate.
 */

/**
 * The `applicationPolicyVersion` component, and the value stored on the case.
 *
 * §7.3 names one component but a version token alone does not identify a policy:
 * two policy sets in one application can both be at `2026.07`, and treating them
 * as the same policy would merge a case decided under community rules with one
 * decided under commerce rules. Composing both halves keeps §12.7's index at the
 * four fields it specifies while making the fourth of them actually identifying.
 */
export function policyVersionToken(policySetId: string, version: string): string {
  return `${policySetId}@${version}`;
}

export interface CaseDedupComponents {
  readonly applicationId: string;
  readonly subjectExternalId: string;
  readonly contentEnvelopeHash: string;
  readonly applicationPolicyVersion: string;
}

/** §7.3's key. */
export function caseDedupKey(components: CaseDedupComponents): string {
  const joined = [
    components.applicationId,
    components.subjectExternalId,
    components.contentEnvelopeHash,
    components.applicationPolicyVersion,
  ].join(':');

  return `sha256:${createHash('sha256').update(joined, 'utf8').digest('hex')}`;
}
