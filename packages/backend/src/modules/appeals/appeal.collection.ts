import type { AppealReason } from '@oxyhq/crowdsource-contracts';

import { defineTenantCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';

/**
 * Appeals (§9.8, §9.9, §12.6's `appeals`).
 *
 * One row per appeal, and the row is APPEND-ONLY — nothing in this module updates
 * one after it is written. That is not austerity, it is the same reasoning §9.9
 * applies to decisions: an appeal's outcome is the decision at the revision it
 * opened, so a `status` column here would be a second copy of a fact the
 * decisions collection already owns, and the two would eventually disagree about
 * whether an appeal had been answered. `appealView` derives the status instead.
 *
 * ## What the row does own
 *
 * Everything about the FILING, which nothing else records: who appealed, why,
 * what they added, and the two revisions the appeal sits between. Plus the two
 * numbers §9.4's appeal row turns into a threshold — the bar the superseded
 * decision cleared, and whether the action it recommended was severe — captured
 * at filing time so the standard the new panel is held to is auditable and cannot
 * drift when the ladder is next edited.
 *
 * ## The author's context is case content
 *
 * `authorContext` holds text the subject of the case wrote. It is redacted before
 * it is stored (§9.8, see `appealContext.ts`) and it is treated as case material
 * everywhere afterwards: never logged, never in an audit row, never in a webhook
 * body, and never in an attestation. The application that filed it already has
 * it, so nothing is lost by refusing to echo it back.
 */

export interface AppealAuthorContextDocument {
  /** Redacted at ingress. The raw bytes are never stored (§9.8). */
  statement: string;
  /** Resources of the case's own snapshot. Validated against it at filing. */
  resourceIds: string[];
  /** §9.8's structured evidence: flat scalars, values redacted. */
  fields: Record<string, string | number | boolean | null>;
}

export interface AppealDocument extends TenantContext {
  appealId: string;
  caseId: string;

  /** The revision whose decision was appealed. Superseded by this appeal (§9.9). */
  supersededRevision: number;
  supersededDecisionId: string;
  /** The revision this appeal opened. Always `supersededRevision + 1`. */
  openedRevision: number;

  reason: AppealReason;
  /**
   * The application's own id for the person appealing.
   *
   * Checked at filing against the principals the CASE MATERIAL points at, which
   * is what makes §9.8's "el autor" enforceable: a reporter is referenced by an
   * allegation and never by the material, so a reporter's id is not in that set.
   * Stored so a later audit can answer "who appealed" without re-deriving it, and
   * tenant-scoped like everything else that carries an application's own ids.
   */
  appellantExternalPrincipalId: string;

  authorContext: AppealAuthorContextDocument | null;

  /**
   * §9.4's appeal row, resolved at filing time.
   *
   * `previousRequiredVotes` is the threshold the superseded decision had to clear.
   * `severeAction` is whether what it recommended was severe. Together they are
   * what "umbral superior al de la primera decisión cuando la acción sea grave"
   * means for THIS appeal, and `requiredAgreeingVotes` is the resulting bar —
   * stored rather than recomputed so the panel is judged by the standard that was
   * in force when the author appealed.
   */
  previousRequiredVotes: number;
  severeAction: boolean;
  requiredAgreeingVotes: number;

  /**
   * The caller's retry key, as `POST /v1/reports` requires one (§10.4).
   *
   * Required rather than optional for the same reason it is there: a retry with no
   * key can only be recognised by its content, and two appeals of two different
   * revisions can legitimately carry identical content — the same author, the same
   * reason, the same explanation, filed again against the decision the first appeal
   * produced. Content alone cannot tell that apart from a retry, and getting it
   * wrong in the safe-looking direction silently swallows the second appeal.
   */
  idempotencyKey: string;
  /**
   * A fingerprint of the filing, for §10.5's replay-versus-conflict distinction.
   *
   * The same appeal under the same key returns the first one; DIFFERENT content
   * under a key already used is a 409. Without this, an application retrying from
   * its own outbox could not tell a successful retry from a refused second appeal.
   */
  payloadHash: string;

  filedAt: Date;
  /** The credential that filed it (§13.2). Never an end user. */
  filedByCredentialId: string;
  createdAt: Date;
  updatedAt: Date;
}

export const appeals = defineTenantCollection<AppealDocument>('Appeal');
