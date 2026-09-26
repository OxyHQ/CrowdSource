import { ERASED_ACCOUNT } from './erasedIdentity';

/**
 * Removing a person's id from stored moderation material: a report's envelope
 * and a case's content snapshot. Pure functions over the stored JSON, so every
 * rule here is tested without a database.
 *
 * ## What changes, and what deliberately does not
 *
 * - **A principal binding that names the person** — by `externalPrincipalId`, or
 *   by `bindingProofId` (the Oxy subject an `oxy_user` binding carries) — keeps
 *   its `principalRef` and `type` and has both identity fields replaced with
 *   {@link ERASED_ACCOUNT}. The binding stays, so the envelope still parses
 *   against the contract (an `oxy_user` binding must carry a proof) and every
 *   resource, relation and allegation that points at the ref still resolves.
 * - **The person's own words as a reporter** — `details` on an allegation whose
 *   `reporterPrincipalRef` is the person's — are removed. The allegation CODE
 *   stays: it is the claim the case was opened on.
 * - **The material itself is not touched.** A report about the person's post
 *   carries that post: it is the evidence a published decision rests on, kept
 *   under GDPR Art. 17(3)(e) and the DSA's record-keeping, and a decision is
 *   never edited (`AGENTS.md`). What goes is the link from it to the person.
 * - **`principalRef` is not rewritten.** It is a truncated SHA-256 of the type
 *   and id (`@crowdsource.you/core`'s `principalRef`), referenced from published
 *   decisions that may never be edited. Without the binding nothing in this
 *   database maps it back to the person; someone who already holds the id could
 *   recompute it, which is why this is pseudonymisation of retained records,
 *   not a claim of anonymity. See `docs/architecture/account-erasure.md`.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface EnvelopeErasure {
  /** The envelope with the person removed; `null` when it did not name them. */
  readonly envelope: Json | null;
  readonly bindingsErased: number;
  readonly detailsCleared: number;
}

export function eraseFromEnvelope(stored: unknown, principalId: string): EnvelopeErasure {
  if (!isRecord(stored) || !Array.isArray(stored.principalBindings)) {
    return { envelope: null, bindingsErased: 0, detailsCleared: 0 };
  }

  const erasedRefs = new Set<string>();
  let bindingsErased = 0;
  const principalBindings = stored.principalBindings.map((binding: unknown) => {
    if (!isRecord(binding)) return binding;
    const names = binding.externalPrincipalId === principalId || binding.bindingProofId === principalId;
    if (!names) return binding;
    bindingsErased += 1;
    if (typeof binding.principalRef === 'string') erasedRefs.add(binding.principalRef);
    return {
      ...binding,
      ...(binding.externalPrincipalId === undefined ? {} : { externalPrincipalId: ERASED_ACCOUNT }),
      ...(binding.bindingProofId === undefined ? {} : { bindingProofId: ERASED_ACCOUNT }),
    };
  });

  let detailsCleared = 0;
  const allegations = Array.isArray(stored.allegations)
    ? stored.allegations.map((allegation: unknown) => {
        if (
          !isRecord(allegation) ||
          typeof allegation.reporterPrincipalRef !== 'string' ||
          !erasedRefs.has(allegation.reporterPrincipalRef) ||
          allegation.details === undefined
        ) {
          return allegation;
        }
        detailsCleared += 1;
        const { details: _details, ...rest } = allegation;
        return rest;
      })
    : stored.allegations;

  if (bindingsErased === 0) return { envelope: null, bindingsErased: 0, detailsCleared: 0 };
  return {
    envelope: { ...stored, principalBindings, allegations },
    bindingsErased,
    detailsCleared,
  };
}

/**
 * A case snapshot's `principals` (`contentSnapshot.ts`): the same replacement
 * for a principal the MATERIAL points at, typically the reported post's author.
 * `content_hash` is left as it is: it is a digest, it is what later reports of
 * the same material dedupe against, and the material itself is unchanged.
 */
export function eraseFromSnapshot(stored: unknown, principalId: string): { snapshot: Json | null; principalsErased: number } {
  if (!isRecord(stored) || !Array.isArray(stored.principals)) return { snapshot: null, principalsErased: 0 };
  let principalsErased = 0;
  const principals = stored.principals.map((principal: unknown) => {
    if (!isRecord(principal) || principal.externalPrincipalId !== principalId) return principal;
    principalsErased += 1;
    return { ...principal, externalPrincipalId: ERASED_ACCOUNT };
  });
  return principalsErased === 0
    ? { snapshot: null, principalsErased: 0 }
    : { snapshot: { ...stored, principals }, principalsErased };
}

/**
 * A case's reporter set with the person's fingerprint swapped for a stand-in,
 * so the case still counts the same number of distinct reporters (§7.4 reads
 * the count) while no value in it is derivable from the person's id.
 */
export function replaceFingerprint(
  fingerprints: readonly string[],
  personal: string,
  standIn: string,
): { fingerprints: string[]; replaced: number } {
  let replaced = 0;
  const next = fingerprints.map((fingerprint) => {
    if (fingerprint !== personal) return fingerprint;
    replaced += 1;
    return standIn;
  });
  return { fingerprints: next, replaced };
}
