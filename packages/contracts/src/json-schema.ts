/**
 * The same contracts as JSON Schema, for integrators who are not on TypeScript.
 *
 * §15.2 asks for "Zod and exportable JSON Schema". Conversion is deliberately
 * lazy — a function, not a frozen constant — so importing the package to
 * validate one report does not pay for thirteen schema conversions.
 *
 * **What JSON Schema does NOT carry.** Zod refinements have no JSON Schema
 * equivalent and are dropped silently by the conversion. Everything structural
 * survives — types, enums, patterns, bounds, required keys, `additionalProperties`
 * — and every cross-field and cross-reference rule does not:
 *
 *   * §5.5 reference resolution (relations, `primaryResourceId`, allegation
 *     resource ids, author and seller refs, conversation members, avatars)
 *   * the `oxy_user` binding-proof requirement
 *   * a required `fileId` on every asset, media type agreement, coarse coordinates,
 *     price-with-currency
 *   * `agreement = winningVotes / decisiveVotes` and the vote count nesting
 *   * revision 1 supersedes nothing / later revisions must
 *   * `externalReportId` matching between request and envelope
 *
 * So a payload that passes the JSON Schema is well-FORMED, not accepted. The
 * server validates with Zod, and that is the authority. This is stated here
 * because an integrator who assumes otherwise will build against a contract
 * that is looser than the one they will meet in production, and will discover
 * the difference as a 422.
 */

import { z } from 'zod';

import { AppealSchema, AppealSubmissionSchema } from './appeals';
import { CaseEnvelopeSchema, CreateReportRequestSchema, CreateReportResponseSchema } from './case-envelope';
import { DecisionSchema } from './decisions';
import { PolicySetVersionSchema } from './policies';
import { ReputationEventSchema } from './reputation-events';
import { RelationSchema, ResourceSchema, ResourceSchemaRegistrationSchema } from './resources';
import { RecusalSubmissionSchema, ReviewSubmissionSchema } from './reviews';
import { KnownWebhookEventSchema, WebhookEventEnvelopeSchema } from './webhooks';

/** A JSON Schema document, as produced by the conversion. */
export type JsonSchemaDocument = z.core.JSONSchema.BaseSchema;

export const CONTRACT_JSON_SCHEMA_NAMES = [
  'case-envelope',
  'create-report-request',
  'create-report-response',
  'resource',
  'relation',
  'resource-schema-registration',
  'policy-set-version',
  'review-submission',
  'recusal-submission',
  'decision',
  'appeal-submission',
  'appeal',
  'webhook-event-envelope',
  'known-webhook-event',
  'reputation-event',
] as const;

export type ContractJsonSchemaName = (typeof CONTRACT_JSON_SCHEMA_NAMES)[number];

/**
 * The Zod schema behind each published name.
 *
 * Typed as an exhaustive `Record` so adding a name without a schema — or a
 * schema without a name — is a compile error rather than a runtime hole in the
 * exported contract set.
 */
export const CONTRACT_SCHEMAS: Record<ContractJsonSchemaName, z.ZodType> = {
  'case-envelope': CaseEnvelopeSchema,
  'create-report-request': CreateReportRequestSchema,
  'create-report-response': CreateReportResponseSchema,
  resource: ResourceSchema,
  relation: RelationSchema,
  'resource-schema-registration': ResourceSchemaRegistrationSchema,
  'policy-set-version': PolicySetVersionSchema,
  'review-submission': ReviewSubmissionSchema,
  'recusal-submission': RecusalSubmissionSchema,
  decision: DecisionSchema,
  'appeal-submission': AppealSubmissionSchema,
  appeal: AppealSchema,
  'webhook-event-envelope': WebhookEventEnvelopeSchema,
  'known-webhook-event': KnownWebhookEventSchema,
  'reputation-event': ReputationEventSchema,
};

/** JSON Schema draft 2020-12, so `$defs` and `unevaluatedProperties` mean what integrators expect. */
const JSON_SCHEMA_TARGET = 'draft-2020-12';

/** The JSON Schema for one published contract. */
export function crowdSourceJsonSchema(name: ContractJsonSchemaName): JsonSchemaDocument {
  return z.toJSONSchema(CONTRACT_SCHEMAS[name], { target: JSON_SCHEMA_TARGET });
}
