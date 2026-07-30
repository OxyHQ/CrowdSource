import type { ModerationLocalStatus } from './types';

/**
 * Decision statuses that end the application's side of the case.
 *
 * A `provisional` decision leaves the report at `submitted`: a later revision
 * may supersede it, and a report the application had already closed would have
 * to be reopened. `superseded` is not here either — a superseded revision is not
 * the current answer and must never be the one that closes the report.
 */
const TERMINAL_DECISION_STATUSES: ReadonlySet<string> = new Set(['final', 'corrected']);

/**
 * Where a decision leaves the report.
 *
 * Takes the decision status as a plain STRING on purpose. This is reached with a
 * value that came off the wire, and a newer CrowdSource introducing a status
 * this version has never seen must be handled rather than throw. An unrecognised
 * status leaves the report open, which is the only safe reading: closing a
 * report on a status nobody has defined would retire a case that may still move.
 */
export function localStatusForDecision(decisionStatus: string): ModerationLocalStatus {
  return TERMINAL_DECISION_STATUSES.has(decisionStatus) ? 'closed' : 'submitted';
}
