/**
 * PLAN §9.1 enforcement — the blindness rules, in code.
 *
 * §9.1 is a table of what a reviewer may see and what they must never see. A
 * layout that happens not to render the forbidden fields is not enforcement: the
 * next screen, the next debugging session or the next `JSON.stringify` puts them
 * back. So the wire payload never enters app state as-is. It is PROJECTED onto
 * the app's own types, field by field, by the functions below — an allowlist, so
 * anything the server sends that is not on it is dropped by construction, not by
 * omission.
 *
 * Two layers, and they do different jobs:
 *
 *  1. `projectAssignmentPackage` builds the object explicitly. This is the
 *     enforcement. There is no path by which `reportCount` or `authorReputation`
 *     survives it, because nothing ever copies them.
 *  2. `scanForForbiddenFields` walks the RAW payload and reports the PATHS of any
 *     field the reviewer must not see. This is the alarm: a backend that starts
 *     sending juror identities is a contract breach that should be visible in
 *     development rather than silently absorbed. It reports paths only — never
 *     values — because those values are exactly the material that must not reach
 *     logs (AGENTS.md, PLAN §13.5).
 */

import { MalformedPayloadError } from './errors';
import type {
  Allegation,
  AssignmentPackage,
  CategoryStanding,
  CertaintyLevel,
  ContextNote,
  EligibilityRequirement,
  EligibilityRequirementId,
  ExposureState,
  PolicyBrief,
  PolicyException,
  PolicyExample,
  PolicyRule,
  ReviewHistoryEntry,
  ReviewHistoryPage,
  ReviewOutcome,
  ReviewResource,
  ReviewResourceKind,
  ReviewerConsent,
  ReviewerPreferences,
  ReviewerProfile,
  ReviewerState,
  SensitivityLevel,
  TrainingModuleSummary,
  TrainingState,
} from './types';

/**
 * Field names a reviewer must never receive, one group per row of the §9.1
 * "Ocultar" column. Matched case-insensitively against object KEYS at any depth.
 *
 * Written as whole-key patterns rather than substrings so that, for example,
 * `reportedAt` is not mistaken for a report COUNT and `authorized` is not
 * mistaken for an AUTHOR. A pattern that is too eager gets disabled by whoever
 * trips over it, which would cost the alarm entirely.
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

// --- typed readers -----------------------------------------------------------
// Deliberately small and explicit. Their only job is to make the projections
// below total: every field is read by name, with a type check, or the payload is
// rejected by path.

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedPayloadError(path || '<root>', 'an object');
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new MalformedPayloadError(`${path}.${key}`, 'a string');
  }
  return value;
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function readNullableString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MalformedPayloadError(`${path}.${key}`, 'a finite number');
  }
  return value;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function readArray<T>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  project: (item: Record<string, unknown>, itemPath: string) => T,
): T[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) =>
    project(asRecord(item, `${path}.${key}[${index}]`), `${path}.${key}[${index}]`),
  );
}

function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): T {
  const value = source[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new MalformedPayloadError(`${path}.${key}`, `one of ${allowed.join(' | ')}`);
  }
  return value as T;
}

// --- projections -------------------------------------------------------------

const RESOURCE_KINDS: readonly ReviewResourceKind[] = [
  'text',
  'image',
  'video',
  'audio',
  'link',
  'file',
];

const SENSITIVITY_LEVELS: readonly SensitivityLevel[] = ['none', 'low', 'high', 'critical'];

const REVIEWER_STATES: readonly ReviewerState[] = [
  'applicant',
  'calibrating',
  'community_reviewer',
  'trusted_reviewer',
  'category_specialist',
  'appeals_reviewer',
  'suspended',
];

const ELIGIBILITY_IDS: readonly EligibilityRequirementId[] = [
  'oxy_account',
  'personhood',
  'age',
  'language_region',
  'training_current',
  'sensitive_consent',
  'no_conflict',
  'no_coordination_signals',
  'no_prior_participation',
  'exposure_headroom',
];

const REVIEW_OUTCOMES: readonly ReviewOutcome[] = [
  'violation',
  'no_violation',
  'insufficient_context',
  'content_unavailable',
];

export const CERTAINTY_LEVELS: readonly CertaintyLevel[] = ['low', 'medium', 'high'];

function projectResource(source: Record<string, unknown>, path: string): ReviewResource {
  return {
    id: readString(source, 'id', path),
    kind: readEnum(source, 'kind', path, RESOURCE_KINDS),
    text: readOptionalString(source, 'text'),
    fileId: readOptionalString(source, 'fileId'),
    url: readOptionalString(source, 'url'),
    mediaType: readOptionalString(source, 'mediaType'),
    sensitive: readBoolean(source, 'sensitive'),
    warnings: readStringArray(source, 'warnings'),
  };
}

function projectContextNote(source: Record<string, unknown>, path: string): ContextNote {
  return { id: readString(source, 'id', path), text: readString(source, 'text', path) };
}

function projectPolicyRule(source: Record<string, unknown>, path: string): PolicyRule {
  return {
    id: readString(source, 'id', path),
    title: readString(source, 'title', path),
    text: readString(source, 'text', path),
    taxonomyCode: readString(source, 'taxonomyCode', path),
  };
}

function projectPolicyException(source: Record<string, unknown>, path: string): PolicyException {
  return {
    id: readString(source, 'id', path),
    title: readString(source, 'title', path),
    text: readString(source, 'text', path),
  };
}

function projectPolicyExample(source: Record<string, unknown>, path: string): PolicyExample {
  return {
    id: readString(source, 'id', path),
    text: readString(source, 'text', path),
    violating: readBoolean(source, 'violating'),
  };
}

function projectPolicyBrief(source: Record<string, unknown>, path: string): PolicyBrief {
  return {
    policySetId: readString(source, 'policySetId', path),
    policyVersion: readString(source, 'policyVersion', path),
    rules: readArray(source, 'rules', path, projectPolicyRule),
    examples: readArray(source, 'examples', path, projectPolicyExample),
    exceptions: readArray(source, 'exceptions', path, projectPolicyException),
  };
}

function projectAllegation(source: Record<string, unknown>, path: string): Allegation {
  return {
    code: readString(source, 'code', path),
    statement: readOptionalString(source, 'statement'),
  };
}

/**
 * Builds the renderable assignment package from a raw response.
 *
 * Every field is named here. That is the point: adding a field to what a
 * reviewer can see requires editing this function, which is a reviewable change
 * against §9.1 — as opposed to a field appearing on screen because the server
 * started sending it.
 */
export function projectAssignmentPackage(payload: unknown): AssignmentPackage {
  const source = asRecord(payload, '');
  const path = 'assignment';
  return {
    assignmentId: readString(source, 'assignmentId', path),
    expiresAt: readString(source, 'expiresAt', path),
    caseRevision: readNumber(source, 'caseRevision', path),
    language: readString(source, 'language', path),
    category: readString(source, 'category', path),
    sensitivity: readEnum(source, 'sensitivity', path, SENSITIVITY_LEVELS),
    warnings: readStringArray(source, 'warnings'),
    resources: readArray(source, 'resources', path, projectResource),
    context: readArray(source, 'context', path, projectContextNote),
    policy: projectPolicyBrief(asRecord(source.policy, `${path}.policy`), `${path}.policy`),
    allegation: projectAllegation(
      asRecord(source.allegation, `${path}.allegation`),
      `${path}.allegation`,
    ),
    watermark: readNullableString(source, 'watermark'),
  };
}

function projectEligibility(
  source: Record<string, unknown>,
  path: string,
): EligibilityRequirement {
  return {
    id: readEnum(source, 'id', path, ELIGIBILITY_IDS),
    met: readBoolean(source, 'met'),
    detail: readOptionalString(source, 'detail'),
  };
}

function projectStanding(source: Record<string, unknown>, path: string): CategoryStanding {
  return {
    category: readString(source, 'category', path),
    language: readString(source, 'language', path),
    reliability: readNumber(source, 'reliability', path),
    reviewsCompleted: readNumber(source, 'reviewsCompleted', path),
    calibrationCurrent: readBoolean(source, 'calibrationCurrent'),
  };
}

function projectPreferences(source: Record<string, unknown>, path: string): ReviewerPreferences {
  return {
    languages: readStringArray(source, 'languages'),
    categories: readStringArray(source, 'categories'),
    sensitiveCategories: readStringArray(source, 'sensitiveCategories'),
    dailyLimit: readNumber(source, 'dailyLimit', path),
    availableForAssignment: readBoolean(source, 'availableForAssignment'),
  };
}

function projectConsent(source: Record<string, unknown>): ReviewerConsent {
  return {
    rulesAcceptedAt: readNullableString(source, 'rulesAcceptedAt'),
    ageConfirmed: readBoolean(source, 'ageConfirmed'),
    sensitiveCategories: readStringArray(source, 'sensitiveCategories'),
  };
}

function projectExposure(source: Record<string, unknown>, path: string): ExposureState {
  return {
    reviewedToday: readNumber(source, 'reviewedToday', path),
    dailyLimit: readNumber(source, 'dailyLimit', path),
    breakRequiredUntil: readNullableString(source, 'breakRequiredUntil'),
  };
}

export function projectReviewerProfile(payload: unknown): ReviewerProfile {
  const source = asRecord(payload, '');
  const path = 'profile';
  return {
    state: readEnum(source, 'state', path, REVIEWER_STATES),
    eligibility: readArray(source, 'eligibility', path, projectEligibility),
    standings: readArray(source, 'standings', path, projectStanding),
    preferences: projectPreferences(
      asRecord(source.preferences, `${path}.preferences`),
      `${path}.preferences`,
    ),
    consent: projectConsent(asRecord(source.consent, `${path}.consent`)),
    exposure: projectExposure(asRecord(source.exposure, `${path}.exposure`), `${path}.exposure`),
  };
}

function projectTrainingModule(
  source: Record<string, unknown>,
  path: string,
): TrainingModuleSummary {
  return {
    id: readString(source, 'id', path),
    title: readString(source, 'title', path),
    category: readString(source, 'category', path),
    completedAt: readNullableString(source, 'completedAt'),
    expiresAt: readNullableString(source, 'expiresAt'),
    calibrationCaseCount: readNumber(source, 'calibrationCaseCount', path),
  };
}

export function projectTrainingState(payload: unknown): TrainingState {
  const source = asRecord(payload, '');
  const path = 'training';
  return {
    modules: readArray(source, 'modules', path, projectTrainingModule),
    calibrationCurrentUntil: readNullableString(source, 'calibrationCurrentUntil'),
    calibrationCasesAnswered: readNumber(source, 'calibrationCasesAnswered', path),
    calibrationCasesRequired: readNumber(source, 'calibrationCasesRequired', path),
  };
}

function projectHistoryEntry(source: Record<string, unknown>, path: string): ReviewHistoryEntry {
  const decision = source.decision;
  return {
    reviewId: readString(source, 'reviewId', path),
    submittedAt: readString(source, 'submittedAt', path),
    category: readString(source, 'category', path),
    language: readString(source, 'language', path),
    outcome: readEnum(source, 'outcome', path, REVIEW_OUTCOMES),
    // Null until the decision is final AND disclosable. A partial or provisional
    // result is not a decision and has no representation here (§9.1).
    decision:
      typeof decision === 'object' && decision !== null && !Array.isArray(decision)
        ? {
            outcome: readString(
              decision as Record<string, unknown>,
              'outcome',
              `${path}.decision`,
            ),
            publishedAt: readString(
              decision as Record<string, unknown>,
              'publishedAt',
              `${path}.decision`,
            ),
          }
        : null,
  };
}

export function projectHistoryPage(payload: unknown): ReviewHistoryPage {
  const source = asRecord(payload, '');
  return {
    entries: readArray(source, 'entries', 'history', projectHistoryEntry),
    nextCursor: readNullableString(source, 'nextCursor'),
  };
}
