/**
 * PLAN §9.1 enforcement — the blindness rules, in code.
 *
 * §9.1 is a table of what a reviewer may see and what they must never see. A
 * layout that happens not to render the forbidden fields is not enforcement: the
 * next screen, the next debugging session or the next `JSON.stringify` puts them
 * back. So the wire payload never enters app state as-is. It goes through the
 * contract's own schemas, which are `.strict()` at every level, and anything the
 * server sends that is not on the contract stops here.
 *
 * Two layers, and they do different jobs:
 *
 *  1. The PARSE is the enforcement. `AssignmentPackageSchema` and its siblings
 *     live in `@oxyhq/crowdsource-contracts` and describe exactly what §9.1
 *     permits; a payload carrying `reportCount` or `authorReputation` is REFUSED
 *     rather than trimmed, so there is no path by which one reaches a screen.
 *     Refusing rather than trimming is the deliberate choice: a blank screen is a
 *     bug somebody fixes today, and an author's reputation on screen is a bug
 *     nobody notices.
 *  2. `scanForForbiddenFields` walks the RAW payload and reports the PATHS of any
 *     field the reviewer must not see. This is the alarm, and it runs BEFORE the
 *     parse so a breach is diagnosable rather than showing up as an opaque
 *     validation failure. It reports paths only — never values — because those
 *     values are exactly the material that must not reach logs (AGENTS.md,
 *     PLAN §13.5).
 *
 * The types these functions return come from the contract too, so the backend's
 * builders and these projections are pinned to one declaration: a renamed field
 * is a compile error on both sides at once, which is the check whose absence let
 * the two drift into disagreeing about nearly every shape on this surface.
 */

import {
  AssignmentPackageSchema,
  IssuedAssignmentPackageSchema,
  ReviewerCalibrationResultViewSchema,
  ReviewerProfileViewSchema,
  ReviewerTrainingViewSchema,
  ReviewHistoryPageSchema,
  type AssignmentPackage,
  type IssuedAssignmentPackage,
  type ReviewerCalibrationResultView,
  type ReviewerProfileView,
  type ReviewerTrainingView,
  type ReviewHistoryPage,
} from '@oxyhq/crowdsource-contracts';
import type { z } from 'zod';

import { MalformedPayloadError } from './errors';

/**
 * Field names a reviewer must never receive, one group per row of the §9.1
 * "Ocultar" column. Matched case-insensitively against object KEYS at any depth.
 *
 * Written as whole-key patterns rather than substrings so that, for example,
 * `reportedAt` is not mistaken for a report COUNT and `authorized` is not
 * mistaken for an AUTHOR. A pattern that is too eager gets disabled by whoever
 * trips over it, which would cost the alarm entirely.
 *
 * `authorPrincipalRef` deliberately matches none of these. It is an
 * envelope-scoped pseudonym that resolves to nothing outside one case, and which
 * resources share an author is the context a harassment allegation cannot be
 * judged without — §9.1 hides the author's IDENTITY and REPUTATION, and a
 * per-envelope ref is neither.
 */
export const FORBIDDEN_FIELD_PATTERNS: readonly RegExp[] = [
  // §9.1 "Número total de reportes"
  /^(report|reports|report_?count|reports_?count|total_?reports|num_?reports|duplicate_?reports)$/i,
  /^reporters?$/i,
  // §9.1 "Reputación del denunciante"
  /^reporter_?(id|ids|name|handle|username|reputation|trust|score|standing|karma)$/i,
  // §9.1 "Reputación del autor"
  /^authors?$/i,
  /^author_?(id|ids|name|handle|username|reputation|trust|score|standing|karma)$/i,
  /^subject_?(reputation|trust|score|standing|karma)$/i,
  /^(reputation|karma|trust_?score|standing)$/i,
  // §9.1 "Votos anteriores o resultado parcial"
  /^(vote|votes|vote_?count|votes_?cast|tally|partial_?result|partial_?outcome|provisional_?outcome|current_?outcome|running_?outcome|agreement|consensus|confidence_?so_?far)$/i,
  // §9.1 "Identidad de otros jurados"
  /^(juror|jurors|jury|panel_?members|other_?reviewers|reviewer_?ids|co_?reviewers)$/i,
  // §9.1 "Popularidad, fama o marca de la aplicación cuando no sea necesaria"
  /^(application_?name|application_?brand|application_?logo|application_?icon|app_?name|app_?brand|brand|tenant_?name|organization_?name)$/i,
  /^(popularity|likes|like_?count|followers|follower_?count|views|view_?count|shares|share_?count|engagement|virality|is_?verified|verified_?badge)$/i,
];

const MAX_SCAN_NODES = 5000;
const MAX_SCAN_DEPTH = 12;

/**
 * Walks a raw payload and returns the dotted PATHS of every field a reviewer
 * must not see. Values are never read, never returned and never logged.
 *
 * Bounded on both node count and depth: a hostile or merely enormous payload
 * must not be able to spend the main thread here. Truncation is reported as its
 * own path so a silent stop can never read as a clean scan.
 */
export function scanForForbiddenFields(payload: unknown): string[] {
  const found: string[] = [];
  let visited = 0;
  let truncated = false;

  const walk = (node: unknown, path: string, depth: number): void => {
    if (truncated || node === null || typeof node !== 'object') {
      return;
    }
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_NODES) {
      truncated = true;
      return;
    }
    visited += 1;

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
        found.push(childPath);
      }
      walk(value, childPath, depth + 1);
    }
  };

  walk(payload, '', 0);
  if (truncated) {
    found.push('<scan-truncated>');
  }
  return found;
}

/**
 * Parses a payload against a contract schema, or throws a `MalformedPayloadError`
 * naming the PATH that failed.
 *
 * The path and the expectation, never the value. A Zod issue on a reviewer
 * payload points into case material — a reported text, a reviewer's own note —
 * and this error is rendered on screen and may be logged, so the value must not
 * travel with it (§13.5).
 */
function parseOrThrow<T>(schema: z.ZodType<T>, payload: unknown, subject: string): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  const path =
    issue === undefined || issue.path.length === 0
      ? subject
      : `${subject}.${issue.path.join('.')}`;
  throw new MalformedPayloadError(path, issue?.message ?? 'a value the contract allows');
}

/**
 * Builds the renderable assignment package from a raw response.
 *
 * The schema names every field a reviewer may receive. That is the point: adding
 * a field to what a reviewer can see requires editing the published contract,
 * which is a reviewable change against §9.1 in one place — as opposed to a field
 * appearing on screen because a server started sending it.
 */
export function projectAssignmentPackage(payload: unknown): AssignmentPackage {
  return parseOrThrow(AssignmentPackageSchema, payload, 'assignment');
}

/**
 * The same, for the one response that also carries the assignment token (§8.7).
 *
 * Separate from the above rather than optional on it, because the token arriving
 * where it is not expected is a server behaving unexpectedly, and the token
 * MISSING from `POST /assignments/next` means every later call on this assignment
 * will 404 — a failure worth catching at the boundary rather than three screens
 * later.
 */
export function projectIssuedAssignment(payload: unknown): IssuedAssignmentPackage {
  return parseOrThrow(IssuedAssignmentPackageSchema, payload, 'assignment');
}

export function projectReviewerProfile(payload: unknown): ReviewerProfileView {
  return parseOrThrow(ReviewerProfileViewSchema, payload, 'profile');
}

export function projectTrainingState(payload: unknown): ReviewerTrainingView {
  return parseOrThrow(ReviewerTrainingViewSchema, payload, 'training');
}

export function projectCalibrationResult(payload: unknown): ReviewerCalibrationResultView {
  return parseOrThrow(ReviewerCalibrationResultViewSchema, payload, 'calibration');
}

export function projectHistoryPage(payload: unknown): ReviewHistoryPage {
  return parseOrThrow(ReviewHistoryPageSchema, payload, 'history');
}
