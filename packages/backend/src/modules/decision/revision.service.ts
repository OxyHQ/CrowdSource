import type { TransactionSession } from '../../db/collections';

import { withTransaction } from '../../db/transaction';
import type { TenantContext } from '../../db/tenantScope';
import { logger } from '../../utils/logger';
import { cases } from '../cases/case.collection';
import { appendOutboxEvent, OUTBOX_EVENT_TYPES } from '../outbox/outbox.collection';
import { markSuperseded } from './decision.service';

/**
 * Opening a new revision of a case (§9.9, §6.4).
 *
 * This is the supersession half of "a published decision is never edited". §9.9
 * gives the shape as a worked example:
 *
 *     Case case_123
 *       Decision revision 1  status = superseded  outcome = violation
 *     Appeal appeal_456
 *       Decision revision 2  status = final       outcome = no_violation
 *                            supersedes = decision_revision_1
 *
 * Nothing about revision 1 changes except that it stops being current. The new
 * outcome is a NEW ROW, and the interface shows the current one while keeping
 * the whole history.
 *
 * ## What this is not
 *
 * It is not an appeal. §9.8's appeal is an object with a requester, a reason,
 * structured additional context from the author, and an appeals-reviewer pool —
 * a surface that belongs to §15.9. What is here is the mechanism such a surface
 * would call, and it is built now because §15.5 asks for immutability AND
 * supersession in this phase, and immutability with no way to supersede is not a
 * property anybody can verify.
 *
 * Two of §9.8's rules already hold, without this file doing anything, because
 * the draw was written correctly in phase 3:
 *
 *  - **"Jurado nuevo. Ningún miembro del jurado original puede participar."**
 *    `gatherParties` collects prior jurors from EVERY assignment on the case,
 *    across all revisions, and the exclusion refuses them. So a revision-2 panel
 *    cannot contain anyone who sat on revision 1.
 *  - **"Ceguera. El nuevo jurado no ve los votos originales."** No reviewer
 *    surface can reach a decision or a review; the assignment package (§9.1)
 *    projects the material and the policy and nothing else.
 *
 * ## Why the swap
 *
 * The same reason publishing has one. A revision that opened twice would draw
 * two panels for revision 2, and the second one's ballots would count toward a
 * revision that was already being decided. The filter requires the case to be
 * decided AT the revision being superseded — you cannot open revision 2 of a
 * case whose revision 1 nobody ever decided — and the increment is conditional
 * on that, so a replay moves nothing.
 */

export type RevisionOutcome =
  | { readonly opened: true; readonly revision: number }
  /** The case is not in a state a revision can be opened from. */
  | { readonly opened: false; readonly reason: 'not_decided' };

/**
 * Moves a case to its next revision and asks for a fresh panel.
 *
 * The draw is requested through the outbox rather than performed here: a panel
 * that lived only in this request would be lost the moment the request failed
 * after the revision committed, leaving a case stuck at `appealed` with a
 * superseded decision, no jury, and nothing recording that a jury was owed.
 *
 * `session` is how the APPEAL that causes a revision commits with it. §9.8's
 * appeal and the revision it opens are one act: an appeal row without a revision
 * is an author told their case is being re-reviewed when no jury was ever asked
 * for, and a revision without an appeal row is a case in `appealed` status that
 * nothing explains. Passing the caller's session is what makes them atomic; when
 * no session is given this opens its own transaction, which is what the audit and
 * operational paths that supersede without an appeal need.
 */
export async function openCaseRevision(
  context: TenantContext,
  caseId: string,
  now: Date = new Date(),
  session?: TransactionSession,
): Promise<RevisionOutcome> {
  const stored = await cases.findOne(context, { caseId });
  if (!stored) {
    throw new Error(`A revision was asked for case '${caseId}', which this tenant does not own.`);
  }

  const superseded = stored.currentRevision;
  const next = superseded + 1;

  const open = async (inSession: TransactionSession): Promise<RevisionOutcome> => {
    const swapped = await cases.updateOne(
      context,
      { caseId, currentRevision: superseded, decidedRevision: superseded },
      { set: { currentRevision: next, status: 'appealed', updatedAt: now } },
      inSession,
    );

    if (swapped === 0) {
      return { opened: false, reason: 'not_decided' };
    }

    /**
     * §9.9: `status = superseded` on the previous revision, and nothing else
     * about it. `markSuperseded` is the only write in this module against an
     * already-published decision and it sets that one field.
     */
    await markSuperseded(context, caseId, superseded, now, inSession);

    await appendOutboxEvent(context, inSession, {
      type: OUTBOX_EVENT_TYPES.caseReadyForReview,
      payload: { caseId },
    });

    logger.info({ caseId, superseded, revision: next }, 'A new case revision was opened');
    return { opened: true, revision: next };
  };

  return session === undefined ? withTransaction<RevisionOutcome>(open) : open(session);
}
