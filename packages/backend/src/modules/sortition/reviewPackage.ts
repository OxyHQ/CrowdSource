import { createHash } from 'node:crypto';
import {
  REVIEWER_SENSITIVITY_CLASSES,
  taxonomyFamilyOf,
  type AssignmentPackage,
  type ReviewerAssetView,
  type ReviewerResource,
  type ReviewerSensitivityClass,
  type Resource,
  type TaxonomyCode,
  type TaxonomyFamily,
} from '@oxyhq/crowdsource-contracts';

import type { CaseDocument } from '../cases/case.collection';
import type { ResolvedPolicy } from '../policy/policy.registry';
import type { SensitivityClass } from '../triage/triage';
import type { AssignmentDocument } from './assignment.collection';

/**
 * The renderable package a juror is authorised to see (§8.7, §9.1).
 *
 * Pure: an assignment, a case and a resolved policy in, the wire object out. It
 * takes no database and no request, which is what makes §9.1's two lists
 * assertable without a draw — and §9.1 is almost entirely a statement about what
 * is ABSENT, so the assertions that matter are the cheap ones.
 *
 * ## §9.1's lists, as code
 *
 * SHOWN: the resources and the context needed to judge them, the allegation AS AN
 * UNVERIFIED ALLEGATION, the applicable policy and its rules, language, warnings
 * and sensitivity, and the tools to work with the material.
 *
 * HIDDEN: the number of reports, any reputation, prior votes or partial results,
 * the identity of other jurors, and the application's identity — a reviewer who
 * knows which product a case came from is a reviewer who knows its brand.
 *
 * Every one of those is hidden here by not being named, not by being deleted. The
 * case document carries `reportCount`, `reporterFingerprints`, `priorityScore`,
 * `escalated`, `decidedRevision` and the tenant keys; the assignment carries
 * `drawId`, `slotType`, `incidentId` and `tokenHash`. None appears below, and
 * adding one means editing this function — a change a reviewer can be pointed at.
 *
 * ## There is no `caseId`
 *
 * §8.7 asks for resource and application ids to be pseudonymised where they are
 * not needed, and a case id is not needed to judge material. More to the point, a
 * case id on the wire is a case id in a URL: "nobody chooses the case they
 * review" holds because the assignment is the only handle anybody ever gets. The
 * resource ids ARE needed — a finding names the resource it is about — so they
 * stay.
 */

/**
 * §13.8's pseudonymous per-assignment watermark.
 *
 * Derived from the assignment id, which makes it three things at once:
 *
 *  - **Traceable.** The server can recompute it for any assignment and match, so
 *    a leaked screenshot names the assignment it came from — and the assignment
 *    row names the reviewer. That is the whole requirement.
 *  - **Free of usable ids.** §8.7 wants the reviewer's view to carry nothing
 *    usable at another endpoint. A one-way digest of an id is not that id, so a
 *    watermark pasted into a support ticket authorises nothing.
 *  - **Stable.** The same assignment always watermarks the same, so reloading the
 *    case does not change the mark, and two screenshots of one session cannot be
 *    told apart from two sessions.
 *
 * No keyed MAC, deliberately: the input is already an unguessable public id
 * (ULID/UUID, never sequential), so a key would add nothing an attacker does not
 * already lack, and it would add a required secret to a deployment whose secret
 * sync only carries what `src/config` reads.
 *
 * Grouped in fours because the point is that a human can read it off a photograph
 * of a screen.
 */
export function assignmentWatermark(assignmentId: string): string {
  const digest = createHash('sha256').update(assignmentId, 'utf8').digest('hex').slice(0, 12);
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
}

/**
 * The consentable class of an assignment, or a refusal.
 *
 * §7.5 routes `prohibited` material to a specialist team under legal protocol and
 * never to a jury. An assignment holding it is a bug in the draw, and the honest
 * response to that bug is to fail rather than to narrow the value quietly — a
 * silent downgrade would put the one class of material the plan forbids in front
 * of a community reviewer, and nothing downstream would report it.
 */
function reviewerSensitivity(
  sensitivity: SensitivityClass,
  assignmentId: string,
): ReviewerSensitivityClass {
  const found = REVIEWER_SENSITIVITY_CLASSES.find((allowed) => allowed === sensitivity);
  if (found === undefined) {
    throw new Error(
      `Assignment '${assignmentId}' holds '${sensitivity}' material, which is never shown to a jury.`,
    );
  }
  return found;
}

/**
 * An asset as a reviewer receives it (§9.1's last hidden row, and the Oxy media
 * chokepoint).
 *
 * `fileId` is the ONLY thing that crosses. An `AssetRef` also carries `url`, and
 * `url` is a location on the REPORTING APPLICATION's own host: passing it through
 * would put that application's brand in front of the jury (§9.1), bypass the one
 * place every Oxy surface resolves files through, and — worse than either — a
 * reviewer's browser fetching it would tell that host its content is under review,
 * which attacks the blind-jury invariant rather than merely leaking a hostname.
 * `sha256` does not cross either; it is what pins a case to the exact bytes
 * reported, and the case verifies that, not a reviewer.
 *
 * `retrievable` is `true` for every asset the contract can now express, because
 * §5.2 requires a `fileId`. It is not vacuous: it is the field that will carry
 * "material existed and cannot be shown" once evidence retention is built, since
 * nothing today copies bytes into storage CrowdSource controls and an author who
 * deletes a file removes it from the reviewer's screen. Saying so beats dropping
 * the resource, which would hide from the jury that material existed at all —
 * that is why `content_unavailable` is one of the outcomes a reviewer may return.
 */
function reviewerAsset(asset: Extract<Resource, { asset: unknown }>['asset']): ReviewerAssetView {
  return {
    mediaType: asset.mimeType,
    fileId: asset.fileId,
    retrievable: true,
    ...(asset.sizeBytes === undefined ? {} : { sizeBytes: asset.sizeBytes }),
    ...(asset.width === undefined ? {} : { width: asset.width }),
    ...(asset.height === undefined ? {} : { height: asset.height }),
    ...(asset.durationSeconds === undefined ? {} : { durationSeconds: asset.durationSeconds }),
  };
}

/** The fields every resource shares, minus the digest. */
function resourceBase(resource: Resource) {
  return {
    id: resource.id,
    role: resource.role,
    ...(resource.language === undefined ? {} : { language: resource.language }),
    ...(resource.createdAt === undefined ? {} : { createdAt: resource.createdAt }),
    /**
     * Kept, and it is worth saying why: §9.1 hides the author's REPUTATION and
     * IDENTITY, and this is neither. It is an envelope-scoped pseudonym (§13.5's
     * "a pseudonymous principal wherever one suffices") that resolves to nothing
     * outside this one case, and which of the resources share an author is
     * exactly the context a harassment allegation cannot be judged without.
     */
    ...(resource.authorPrincipalRef === undefined
      ? {}
      : { authorPrincipalRef: resource.authorPrincipalRef }),
    ...(resource.sensitivity === undefined ? {} : { sensitivity: resource.sensitivity }),
  };
}

/**
 * One resource, projected onto what a reviewer may receive.
 *
 * One branch per resource type rather than a generic copy-and-delete, for the
 * same reason the app projects field by field: this is a privacy boundary, and a
 * boundary that works by removing known-bad fields fails open the day the
 * envelope gains a field nobody thought about. Here it fails CLOSED — a new
 * resource type in `resources.ts` makes the `never` assignment below a compile
 * error, so it cannot reach a reviewer unreviewed and, just as importantly,
 * cannot be silently dropped from what the jury is shown.
 */
function reviewerResource(resource: Resource): ReviewerResource {
  switch (resource.type) {
    case 'text':
      return { ...resourceBase(resource), type: 'text', data: resource.data };
    case 'link':
      return { ...resourceBase(resource), type: 'link', data: resource.data };
    case 'profile':
      return { ...resourceBase(resource), type: 'profile', data: resource.data };
    case 'conversation':
      return { ...resourceBase(resource), type: 'conversation', data: resource.data };
    case 'listing':
      return { ...resourceBase(resource), type: 'listing', data: resource.data };
    case 'location':
      return { ...resourceBase(resource), type: 'location', data: resource.data };
    case 'metadata':
      return { ...resourceBase(resource), type: 'metadata', data: resource.data };
    case 'custom':
      return {
        ...resourceBase(resource),
        type: 'custom',
        schemaId: resource.schemaId,
        payload: resource.payload,
      };
    case 'image':
      return { ...resourceBase(resource), type: 'image', asset: reviewerAsset(resource.asset) };
    case 'video':
      return {
        ...resourceBase(resource),
        type: 'video',
        asset: reviewerAsset(resource.asset),
        ...(resource.data === undefined ? {} : { data: resource.data }),
      };
    case 'audio':
      return {
        ...resourceBase(resource),
        type: 'audio',
        asset: reviewerAsset(resource.asset),
        ...(resource.data === undefined ? {} : { data: resource.data }),
      };
    case 'document':
      return {
        ...resourceBase(resource),
        type: 'document',
        asset: reviewerAsset(resource.asset),
        data: resource.data,
      };
    default: {
      const unhandled: never = resource;
      throw new Error(
        `A resource type reached the reviewer surface with no projection: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

/**
 * The families a case alleges (§8.5's `caseFactsOf`, same derivation).
 *
 * Plural, because a case is the union of every report about the same material
 * (§7.3) and reporters do not all choose the same code. A reviewer is only drawn
 * when they accept ALL of them (§8.2), so naming one would misdescribe what they
 * were asked to judge.
 */
function familiesOf(stored: CaseDocument): TaxonomyFamily[] {
  return [...new Set(stored.allegationCodes.map((code) => taxonomyFamilyOf(code as TaxonomyCode)))];
}

/**
 * The language of the material, or null.
 *
 * The primary resource's tag when it has one, then any resource's. Null is the
 * honest answer when the envelope declares none — the same reading
 * `CaseEligibilityCriteria` takes, where a language nobody stated cannot be a
 * constraint.
 */
function languageOf(stored: CaseDocument): string | null {
  const primary = stored.contentSnapshot.resources.find(
    (resource) => resource.id === stored.primaryResourceId,
  );
  return (
    primary?.language ??
    stored.contentSnapshot.resources.find((resource) => resource.language !== undefined)?.language ??
    null
  );
}

export function buildReviewPackage(
  assignment: AssignmentDocument,
  stored: CaseDocument,
  policy: ResolvedPolicy,
  /**
   * §9.8's author context, resolved by the caller because it needs a tenant read
   * this pure builder deliberately cannot make. Omitted on a first-instance
   * panel, and omitted rather than nulled so an appeal is never inferable from
   * the field being present and empty.
   */
  authorContext?: AssignmentPackage['authorContext'],
): AssignmentPackage {
  return {
    assignmentId: assignment.assignmentId,
    caseRevision: assignment.caseRevision,
    expiresAt: assignment.expiresAt.toISOString(),
    language: languageOf(stored),
    families: familiesOf(stored),

    /** §9.1: the allegation, labelled as what it is — a claim nobody verified. */
    allegations: {
      unverified: true,
      codes: [...stored.allegationCodes],
    },

    /**
     * §9.1: the applicable policy and its rules, in full.
     *
     * A reviewer is asked whether material breaks a rule, so they are given the
     * rules — including the severities and actions each rule suggests, which is
     * §9.2's second step. Withholding them would be asking somebody to apply a
     * standard nobody showed them.
     */
    policy: {
      policySetId: policy.policySetId,
      version: policy.version,
      taxonomyVersion: policy.taxonomyVersion,
      rules: [...policy.policySet.rules],
    },

    /** §9.1: language, warnings, sensitivity — and §13.7's blur decision. */
    presentation: {
      sensitivityClass: reviewerSensitivity(assignment.sensitivityClass, assignment.assignmentId),
      requiresRedaction: stored.requiresRedaction,
      blurBeforeReveal: assignment.sensitivityClass !== 'standard',
    },

    resources: stored.contentSnapshot.resources.map(reviewerResource),
    relations: [...stored.contentSnapshot.relations],
    watermark: assignmentWatermark(assignment.assignmentId),
    ...(authorContext === undefined ? {} : { authorContext }),
  };
}
