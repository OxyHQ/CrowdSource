/**
 * Outbound webhooks (§10.6–§10.9) and the signature contract (§10.8).
 *
 * §10.11 asks for two behaviours that pull in opposite directions: unknown
 * EVENTS must be ignored safely, and unknown FIELDS must not break clients.
 * This module gives each its own schema rather than compromising on one.
 *
 *   * `WebhookEventEnvelopeSchema` validates only what every event has —
 *     identity, type, timing, tenant — and leaves `data` opaque. A receiver
 *     verifies the signature, records the event id for idempotency, and ignores
 *     what it does not recognise, without a schema update ever being the reason
 *     a delivery fails.
 *   * `KnownWebhookEventSchema` is the discriminated union of the eight events
 *     §10.6 defines, for the branch that actually handles one.
 *
 * Everything here is `.loose()`. These payloads travel from CrowdSource to a
 * tenant, so an unknown field is a newer server, not an attack; stripping it
 * would silently discard data from a receiver that persists `event.data` for
 * later processing — which is precisely what §10.8's "respond 2xx quickly and
 * queue the processing" tells receivers to do.
 */

import { z } from 'zod';

import { CreateReportResponseSchema } from './case-envelope.js';
import { DecisionSchema } from './decisions.js';
import { IdentifierSchema, TimestampSchema } from './primitives.js';
import type { Closed } from './closed.js';

/** §10.6. */
export const WEBHOOK_EVENT_TYPES = [
  'report.received',
  'case.created',
  'case.escalated',
  'case.decided',
  'decision.corrected',
  'appeal.created',
  'appeal.decided',
  'case.closed',
] as const;
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

/**
 * Any event type, including ones this version of the contract does not know.
 *
 * Shape-checked but not enumerated, so that "unknown events must be ignored
 * safely" is something a receiver can DO rather than something it is told about
 * after its parse has already thrown.
 */
export const AnyWebhookEventTypeSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'must be a dotted lowercase event type');

const webhookEnvelopeShape = {
  id: IdentifierSchema,
  createdAt: TimestampSchema,
  organizationId: IdentifierSchema,
  applicationId: IdentifierSchema,
};

/**
 * The envelope every delivery shares (§10.7), with `data` left opaque.
 *
 * Parse with this first. `id` is the idempotency key §10.8 requires receivers
 * to store; `type` decides whether there is anything to do.
 */
export const WebhookEventEnvelopeSchema = z.looseObject({
  ...webhookEnvelopeShape,
  type: AnyWebhookEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEventEnvelope = Closed<z.infer<typeof WebhookEventEnvelopeSchema>>;

const ReportReceivedEventSchema = z.looseObject({
  ...webhookEnvelopeShape,
  type: z.literal('report.received'),
  /** §10.6: "optional confirmation of receipt and merge" — §10.4's response. */
  data: CreateReportResponseSchema,
});

const CaseCreatedEventSchema = z.looseObject({
  ...webhookEnvelopeShape,
  type: z.literal('case.created'),
  data: z.looseObject({ caseId: IdentifierSchema }),
});

const CaseEscalatedEventSchema = z.looseObject({
  ...webhookEnvelopeShape,
  type: z.literal('case.escalated'),
  data: z.looseObject({ caseId: IdentifierSchema }),
});

const CaseDecidedEventSchema = z.looseObject({
  ...webhookEnvelopeShape,
  type: z.literal('case.decided'),
  data: z.looseObject({ caseId: IdentifierSchema, decision: DecisionSchema }),
});

/**
 * §10.6: "a later revision replaces the previous decision".
 *
 * The carried decision must therefore name what it superseded. `DecisionSchema`
 * already requires that of any revision past the first; requiring it again here
 * is what stops a correction from carrying revision 1.
 */
const DecisionCorrectedEventSchema = z.looseObject({
  ...webhookEnvelopeShape,
  type: z.literal('decision.corrected'),
  data: z.looseObject({
    caseId: IdentifierSchema,
    decision: DecisionSchema.refine(
      (decision) => decision.supersedesDecisionId !== undefined,
      { message: 'a corrected decision must supersede the decision it replaces' },
    ),
  }),
});

const AppealCreatedEventSchema = z.looseObject({
  ...webhookEnvelopeShape,
  type: z.literal('appeal.created'),
  data: z.looseObject({ caseId: IdentifierSchema, appealId: IdentifierSchema }),
});

const AppealDecidedEventSchema = z.looseObject({
  ...webhookEnvelopeShape,
  type: z.literal('appeal.decided'),
  data: z.looseObject({
    caseId: IdentifierSchema,
    appealId: IdentifierSchema,
    decision: DecisionSchema,
  }),
});

const CaseClosedEventSchema = z.looseObject({
  ...webhookEnvelopeShape,
  type: z.literal('case.closed'),
  data: z.looseObject({ caseId: IdentifierSchema }),
});

/**
 * The eight events of §10.6, discriminated on `type`.
 *
 * Only `case.decided` has its payload specified in the plan (§10.7). The other
 * seven carry the case they are about and whatever identifies the object that
 * moved; they are loose, so filling them in later is additive and needs no
 * version bump (§10.11).
 */
export const KnownWebhookEventSchema = z.discriminatedUnion('type', [
  ReportReceivedEventSchema,
  CaseCreatedEventSchema,
  CaseEscalatedEventSchema,
  CaseDecidedEventSchema,
  DecisionCorrectedEventSchema,
  AppealCreatedEventSchema,
  AppealDecidedEventSchema,
  CaseClosedEventSchema,
]);
export type KnownWebhookEvent = Closed<z.infer<typeof KnownWebhookEventSchema>>;

/** §10.8 headers, in their canonical casing. HTTP header names are case-insensitive; look them up accordingly. */
export const WEBHOOK_EVENT_ID_HEADER = 'X-CrowdSource-Event-Id';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-CrowdSource-Timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'X-CrowdSource-Signature';

/** The signature scheme prefix, as in `v1=<hex>`. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/** §10.8: reject timestamps more than five minutes away from now. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** Unix seconds, as the header carries them. */
export const WebhookTimestampHeaderSchema = z
  .string()
  .regex(/^[0-9]{1,15}$/, 'must be unix seconds');

/** `v1=<64 lowercase hex>` — HMAC-SHA256 of the signed payload. */
export const WebhookSignatureHeaderSchema = z
  .string()
  .regex(/^v1=[0-9a-f]{64}$/, 'must be "v1=" followed by 64 lowercase hex characters');

/**
 * The exact bytes both sides sign: `timestamp + "." + rawBody` (§10.8).
 *
 * This lives in the contract, not in the signer or the verifier, because a
 * disagreement between those two about what gets signed is invisible until
 * every delivery starts failing — or, far worse, until a signature validates
 * over bytes that are not the ones the receiver goes on to parse. There is no
 * cryptography here and no transport; the HMAC belongs to the backend's signer
 * and the SDK's middleware.
 *
 * `timestamp` is the header value VERBATIM. Re-deriving it from a parsed number
 * is the mistake this signature exists to catch, and the receiver must verify
 * over exactly what arrived.
 */
export function buildWebhookSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/**
 * §10.9's backoff, in seconds after the initial attempt.
 *
 * Published behaviour a tenant plans around, so it belongs to the contract
 * rather than to the delivery worker. After the last one the delivery is
 * `dead_letter`, the tenant is alerted, and replay is manual.
 */
export const WEBHOOK_RETRY_SCHEDULE_SECONDS: readonly number[] = Object.freeze([
  30,
  120,
  900,
  3_600,
  21_600,
  86_400,
]);
