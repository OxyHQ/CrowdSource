/**
 * The Case Envelope (§5.1) — the universal content contract.
 *
 * §5 opens by naming the mistake this contract exists to avoid: designing
 * moderation around `post`, `comment`, `room` or `product`. Nothing below knows
 * what a post is. An envelope is resources, relations, pseudonymous principals,
 * allegations, a policy reference and privacy terms; what the material happens
 * to be called in the application that sent it lives in `subject.type`, which
 * is a namespaced label, not a branch in this file.
 *
 * Two rules govern the whole module.
 *
 * **Everything inbound is strict.** An unknown key on an envelope is either a
 * typo — in which case the application believes it sent context that the jury
 * will never see — or a field somebody hopes will reach the reviewer's screen.
 * Both are rejected loudly. §10.11's "unknown fields must not break clients"
 * governs what CrowdSource SENDS; see `decisions.ts` and `webhooks.ts` for the
 * other half of that rule.
 *
 * **References resolve inside the envelope.** §5.5 requires the backend to
 * check that every referenced id exists. That check lives here, in the schema,
 * because it is a property of the document and nothing downstream can restate
 * it as reliably. It is extended past `relations` to every in-envelope
 * reference — `subject.primaryResourceId`, `allegation.resourceIds`,
 * `authorPrincipalRef`, conversation members, listing media and seller, profile
 * avatar — since a dangling id is the same defect wherever it appears.
 */

import { z } from 'zod';

import {
  CONTRACT_LIMITS,
  ExternalIdSchema,
  HttpUrlSchema,
  IdentifierSchema,
  MetadataBagSchema,
  TimestampSchema,
} from './primitives.js';
import { CasePolicyRefSchema } from './policies.js';
import {
  PRINCIPAL_TARGETED_RELATION_TYPES,
  PrincipalRefSchema,
  RelationSchema,
  ResourceIdSchema,
  ResourceSchema,
} from './resources.js';
import { SensitivityHintSchema, TaxonomyCodeSchema } from './taxonomy.js';
import type { Closed } from './closed.js';

/**
 * The contract version carried inside the payload.
 *
 * §10.11 keeps this separate from the `/v1` route version on purpose: the HTTP
 * surface and the document shape evolve at different speeds, and an additive
 * change to either bumps neither.
 */
export const CASE_ENVELOPE_SCHEMA_VERSION = 'crowdsource.case.v1';

export const CaseEnvelopeSchemaVersionSchema = z.literal(CASE_ENVELOPE_SCHEMA_VERSION);

/** §5.4 namespaced subject types. */
export const STANDARD_SUBJECT_TYPES = [
  'social.post',
  'social.comment',
  'chat.message',
  'chat.conversation',
  'identity.profile',
  'commerce.listing',
  'commerce.review',
  'forum.thread',
  'video.live_segment',
  'document.file',
  'gaming.username',
] as const;

/**
 * A subject type: one of §5.4's standard types, or an application's own
 * `custom.<organization>.<object_type>`.
 *
 * The custom branch is a pattern rather than an open string so a tenant's
 * private vocabulary is always visibly namespaced and can never collide with a
 * standard type or be mistaken for one.
 */
export const SubjectTypeSchema = z.union([
  z.enum(STANDARD_SUBJECT_TYPES),
  z
    .string()
    .max(CONTRACT_LIMITS.IDENTIFIER_MAX_LENGTH)
    .regex(
      /^custom\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$/,
      'a custom subject type must be "custom.<organization>.<object_type>"',
    ),
]);
export type SubjectType = z.infer<typeof SubjectTypeSchema>;

/** §5.1 / Appendix A `subject`. */
export const CaseSubjectSchema = z.strictObject({
  externalId: ExternalIdSchema,
  type: SubjectTypeSchema,
  primaryResourceId: ResourceIdSchema,
  /** Where the application's own users see the object. Never fetched by a jury. */
  permalink: HttpUrlSchema.optional(),
});
export type CaseSubject = z.infer<typeof CaseSubjectSchema>;

/**
 * §3 principal kinds.
 *
 * The plan defines a principal in prose — "an Oxy user, a local user, an
 * organization, a bot or a federated actor" — and only ever writes `oxy_user`
 * in an example. These are those five in the plan's own order; the tokens are
 * this contract's, the concepts are the plan's.
 */
export const PRINCIPAL_TYPES = [
  'oxy_user',
  'local_user',
  'organization',
  'bot',
  'federated_actor',
] as const;
export const PrincipalTypeSchema = z.enum(PRINCIPAL_TYPES);
export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;

/**
 * §5.1 `principalBindings` — proof that a pseudonymous ref corresponds to a
 * verifiable identity.
 *
 * `bindingProofId` is REQUIRED for `oxy_user` and optional for every other
 * principal type. That is the "no binding proof, no Oxy Trust effect" invariant
 * made structural at the earliest possible point: an Oxy identity asserted
 * without a proof cannot be expressed. The other four types can never move Oxy
 * reputation anyway — they have no Oxy identity to move — and requiring a proof
 * from them would lock out every tenant whose users are not Oxy users, which is
 * the multi-tenant case this whole product exists for.
 */
export const PrincipalBindingSchema = z
  .strictObject({
    principalRef: PrincipalRefSchema,
    type: PrincipalTypeSchema,
    /** The application's own id for the actor. Pseudonymous to the jury. */
    externalPrincipalId: ExternalIdSchema.optional(),
    bindingProofId: IdentifierSchema.optional(),
    boundAt: TimestampSchema.optional(),
  })
  .superRefine((binding, ctx) => {
    if (binding.type === 'oxy_user' && binding.bindingProofId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['bindingProofId'],
        message: 'an oxy_user binding must carry a bindingProofId',
      });
    }
  });
export type PrincipalBinding = z.infer<typeof PrincipalBindingSchema>;

/**
 * §5.1 `allegations` — what the reporter claims, not what is true.
 *
 * §9.1 requires the jury to see this as an unverified allegation, and §6.2
 * shows the allegation and the finding diverging as the normal case. Only
 * `code` is required: §5.8's example carries nothing else.
 */
export const AllegationSchema = z.strictObject({
  code: TaxonomyCodeSchema,
  resourceIds: z
    .array(ResourceIdSchema)
    .max(CONTRACT_LIMITS.RESOURCE_REFS_PER_FINDING_MAX)
    .optional(),
  reporterPrincipalRef: PrincipalRefSchema.optional(),
  details: z.string().max(CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH).optional(),
});
export type Allegation = z.infer<typeof AllegationSchema>;

/**
 * The environment the report came from, as the APPLICATION sees it.
 *
 * `staging` is deliberately absent. The plan's §12.4 three-environment model is
 * not what this ecosystem runs — CrowdSource has one deployment, and
 * tenant-facing sandboxing is an application-trust state inside it. A report
 * from a tenant's own pre-production is a sandbox report or it is a real one.
 */
export const SOURCE_ENVIRONMENTS = ['production', 'sandbox'] as const;
export const SourceEnvironmentSchema = z.enum(SOURCE_ENVIRONMENTS);

/** Appendix A `source`. */
export const CaseSourceSchema = z.strictObject({
  environment: SourceEnvironmentSchema,
  submittedAt: TimestampSchema,
});
export type CaseSource = z.infer<typeof CaseSourceSchema>;

/** §5.1 / Appendix A `privacy`. */
export const CasePrivacySchema = z.strictObject({
  /** §13.6 defaults to 30 days after a final decision, configurable by policy. */
  retentionDays: z.number().int().positive().max(CONTRACT_LIMITS.RETENTION_DAYS_MAX),
  /**
   * Whether a community jury may see this at all. `false` routes the case to a
   * specialist pool (§7.5); it is not a preference the triage may override
   * upwards.
   */
  allowCommunityReview: z.boolean(),
  containsPersonalData: z.boolean().optional(),
  sensitivityHint: SensitivityHintSchema.optional(),
});
export type CasePrivacy = z.infer<typeof CasePrivacySchema>;

/**
 * §5.1 / Appendix A `urgency` — an input to triage, never to a verdict.
 *
 * `hint` stays an open lowercase token for the same reason as
 * `sensitivityHint`: the plan names exactly one value (`normal`) and §7.4 makes
 * clear the authoritative priority is computed server-side from several
 * signals, of which this is one. Closing the list is a product decision that
 * has not been made.
 */
export const CaseUrgencySchema = z.strictObject({
  hint: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase token'),
  /** How many people the material reached, as the application counts it. */
  reach: z.number().int().nonnegative().optional(),
  activeDistribution: z.boolean().optional(),
});
export type CaseUrgency = z.infer<typeof CaseUrgencySchema>;

const caseEnvelopeShape = {
  schemaVersion: CaseEnvelopeSchemaVersionSchema,
  /**
   * An assertion by the caller, never the source of tenancy.
   *
   * `applicationId` comes from the credential (Appendix F). This field exists
   * so a mismatch can be DETECTED — the ingress route compares it to the
   * credential-derived id and rejects a disagreement rather than trusting
   * either side silently. No schema can enforce that; it is stated here so the
   * rule travels with the field it constrains.
   */
  applicationId: IdentifierSchema,
  externalReportId: ExternalIdSchema,
  source: CaseSourceSchema.optional(),
  subject: CaseSubjectSchema,
  principalBindings: z
    .array(PrincipalBindingSchema)
    .max(CONTRACT_LIMITS.PRINCIPAL_BINDINGS_PER_ENVELOPE_MAX),
  resources: z.array(ResourceSchema).min(1).max(CONTRACT_LIMITS.RESOURCES_PER_ENVELOPE_MAX),
  relations: z.array(RelationSchema).max(CONTRACT_LIMITS.RELATIONS_PER_ENVELOPE_MAX),
  allegations: z.array(AllegationSchema).min(1).max(CONTRACT_LIMITS.ALLEGATIONS_PER_ENVELOPE_MAX),
  policy: CasePolicyRefSchema,
  privacy: CasePrivacySchema,
  urgency: CaseUrgencySchema.optional(),
  metadata: MetadataBagSchema.optional(),
};

/**
 * The Case Envelope.
 *
 * `principalBindings`, `resources`, `relations` and `allegations` are all
 * required keys, matching §5.1's declared root structure and both worked
 * examples; `resources` and `allegations` additionally require at least one
 * entry, because an envelope with nothing to look at or no claim to evaluate is
 * not a case. `source`, `urgency` and `metadata` are optional — §5.8 omits all
 * three, Appendix A carries all three.
 */
export const CaseEnvelopeSchema = z
  .strictObject(caseEnvelopeShape)
  .superRefine((envelope, ctx) => {
    const resourceIds = new Set<string>();
    envelope.resources.forEach((resource, index) => {
      if (resourceIds.has(resource.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources', index, 'id'],
          message: `duplicate resource id "${resource.id}"`,
        });
      }
      resourceIds.add(resource.id);
    });

    const principalRefs = new Set<string>();
    envelope.principalBindings.forEach((binding, index) => {
      if (principalRefs.has(binding.principalRef)) {
        ctx.addIssue({
          code: 'custom',
          path: ['principalBindings', index, 'principalRef'],
          message: `duplicate principalRef "${binding.principalRef}"`,
        });
      }
      principalRefs.add(binding.principalRef);
    });

    const requireResource = (id: string, path: (string | number)[]): void => {
      if (!resourceIds.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `no resource in this envelope has id "${id}"`,
        });
      }
    };
    const requirePrincipal = (ref: string, path: (string | number)[]): void => {
      if (!principalRefs.has(ref)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `no principal binding in this envelope has principalRef "${ref}"`,
        });
      }
    };

    requireResource(envelope.subject.primaryResourceId, ['subject', 'primaryResourceId']);
    const primary = envelope.resources.find(
      (resource) => resource.id === envelope.subject.primaryResourceId,
    );
    if (primary !== undefined && primary.role !== 'subject') {
      ctx.addIssue({
        code: 'custom',
        path: ['subject', 'primaryResourceId'],
        message: `the primary resource must have role "subject", not "${primary.role}"`,
      });
    }

    envelope.resources.forEach((resource, index) => {
      if (resource.authorPrincipalRef !== undefined) {
        requirePrincipal(resource.authorPrincipalRef, ['resources', index, 'authorPrincipalRef']);
      }
      switch (resource.type) {
        case 'profile':
          if (resource.data.avatarRef !== undefined) {
            requireResource(resource.data.avatarRef, ['resources', index, 'data', 'avatarRef']);
          }
          break;
        case 'conversation':
          resource.data.messageResourceIds.forEach((messageId, messageIndex) => {
            requireResource(messageId, [
              'resources',
              index,
              'data',
              'messageResourceIds',
              messageIndex,
            ]);
          });
          break;
        case 'listing':
          if (resource.data.sellerRef !== undefined) {
            requirePrincipal(resource.data.sellerRef, ['resources', index, 'data', 'sellerRef']);
          }
          resource.data.mediaRefs?.forEach((mediaId, mediaIndex) => {
            requireResource(mediaId, ['resources', index, 'data', 'mediaRefs', mediaIndex]);
          });
          break;
        default:
          break;
      }
    });

    const seenRelations = new Set<string>();
    envelope.relations.forEach((relation, index) => {
      requireResource(relation.from, ['relations', index, 'from']);
      if (PRINCIPAL_TARGETED_RELATION_TYPES.some((type) => type === relation.type)) {
        requirePrincipal(relation.to, ['relations', index, 'to']);
      } else {
        requireResource(relation.to, ['relations', index, 'to']);
        if (relation.from === relation.to) {
          ctx.addIssue({
            code: 'custom',
            path: ['relations', index, 'to'],
            message: 'a resource cannot relate to itself',
          });
        }
      }
      const key = `${relation.from}\u0000${relation.type}\u0000${relation.to}`;
      if (seenRelations.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['relations', index],
          message: 'duplicate relation',
        });
      }
      seenRelations.add(key);
    });

    envelope.allegations.forEach((allegation, index) => {
      allegation.resourceIds?.forEach((resourceId, resourceIndex) => {
        requireResource(resourceId, ['allegations', index, 'resourceIds', resourceIndex]);
      });
      if (allegation.reporterPrincipalRef !== undefined) {
        requirePrincipal(allegation.reporterPrincipalRef, [
          'allegations',
          index,
          'reporterPrincipalRef',
        ]);
      }
    });
  });
export type CaseEnvelope = z.infer<typeof CaseEnvelopeSchema>;

/** §3.2 report states. */
export const REPORT_STATUSES = ['received', 'merged', 'invalid', 'withdrawn', 'closed'] as const;
export const ReportStatusSchema = z.enum(REPORT_STATUSES);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

/**
 * `POST /v1/reports` (§10.4).
 *
 * The request repeats `externalReportId` outside the envelope, so the two must
 * agree — a mismatch means the idempotency key and the document disagree about
 * which report this is, and §12.7's `application_id + external_report_id`
 * uniqueness would then be enforced against the wrong value.
 */
export const CreateReportRequestSchema = z
  .strictObject({
    externalReportId: ExternalIdSchema,
    envelope: CaseEnvelopeSchema,
  })
  .superRefine((request, ctx) => {
    if (request.externalReportId !== request.envelope.externalReportId) {
      ctx.addIssue({
        code: 'custom',
        path: ['envelope', 'externalReportId'],
        message: 'externalReportId must match the envelope',
      });
    }
  });
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;

/** The `202 Accepted` body of §10.4. Loose: it travels outbound (§10.11). */
export const CreateReportResponseSchema = z.looseObject({
  reportId: IdentifierSchema,
  caseId: IdentifierSchema,
  status: ReportStatusSchema,
  merged: z.boolean(),
});
export type CreateReportResponse = Closed<z.infer<typeof CreateReportResponseSchema>>;
