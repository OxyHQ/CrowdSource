/**
 * Scalar contracts shared by every CrowdSource surface.
 *
 * Nothing here belongs to a single contract module; everything here is depended
 * on by several of them. Two properties drive most of the choices below:
 *
 *   1. **The envelope is content-addressed.** §7.3 derives `caseDedupKey` from
 *      `applicationId`, `subject.externalId`, the canonical envelope hash and
 *      the policy version. Two byte-different representations of the SAME value
 *      produce two different keys, therefore two cases, therefore two penalties
 *      for one incident — the exact opposite of the "one penalty per incident"
 *      invariant. So every scalar that can travel in more than one shape is
 *      pinned to ONE canonical shape here: digests are always `sha256:<hex>`,
 *      timestamps are always millisecond-precision UTC.
 *
 *   2. **`:` is a structural separator.** §7.3 joins the dedup key components
 *      with `:`. An identifier that may itself contain `:` makes that join
 *      ambiguous — two distinct tuples can flatten to the same string and merge
 *      two unrelated cases. Every identifier schema below therefore excludes
 *      `:`. (The same character is independently forbidden in BullMQ queue and
 *      job ids, so this also keeps identifiers usable as dispatch keys.)
 */

import { z } from 'zod';

/**
 * Bounds applied across the contracts.
 *
 * §7.2.3 requires ingress to check "size limits, number of resources and MIME
 * types" but the plan never states the numbers. These are the contract's own
 * declared limits: generous enough not to reject real moderation material,
 * finite so that no array or string in the contract is unbounded. A tenant may
 * be held to something tighter by quota; nothing may exceed these.
 */
export const CONTRACT_LIMITS = Object.freeze({
  /** Envelope-local ids (`res_post`), policy ids, principal refs. */
  IDENTIFIER_MAX_LENGTH: 128,
  /** Ids minted by the application (`mention_report_123`, `post_987`). */
  EXTERNAL_ID_MAX_LENGTH: 200,

  RESOURCES_PER_ENVELOPE_MAX: 50,
  RELATIONS_PER_ENVELOPE_MAX: 200,
  ALLEGATIONS_PER_ENVELOPE_MAX: 20,
  PRINCIPAL_BINDINGS_PER_ENVELOPE_MAX: 50,

  /** A reported text resource. Long enough for an article, not a corpus. */
  TEXT_RESOURCE_MAX_LENGTH: 100_000,
  /** Titles, labels, display names, place names. */
  SHORT_TEXT_MAX_LENGTH: 500,
  /** Descriptions, bios, reporter details, reviewer notes. */
  LONG_TEXT_MAX_LENGTH: 5_000,
  /** Audio transcript, document extracted text, link snapshot. */
  EXTRACTED_TEXT_MAX_LENGTH: 200_000,

  METADATA_KEYS_MAX: 50,
  METADATA_KEY_MAX_LENGTH: 64,
  METADATA_STRING_VALUE_MAX_LENGTH: 1_000,

  /** §5.7 custom payloads: data, bounded, never a document tree. */
  CUSTOM_PAYLOAD_MAX_DEPTH: 5,
  CUSTOM_PAYLOAD_ARRAY_MAX_LENGTH: 100,
  CUSTOM_PAYLOAD_STRING_MAX_LENGTH: 10_000,

  CONVERSATION_MESSAGES_MAX: 50,
  LISTING_MEDIA_REFS_MAX: 20,
  PROFILE_CLAIMS_MAX: 20,

  FINDINGS_MAX: 20,
  RESOURCE_REFS_PER_FINDING_MAX: 50,
  POLICY_RULE_IDS_MAX: 20,
  RECOMMENDED_ACTIONS_MAX: 10,

  /** §13.6 defaults to 30 days "configurable by policy"; this is the ceiling. */
  RETENTION_DAYS_MAX: 3_650,
  /** A jury is 3, 5 or 7 today (§9.4). The bound only stops absurd values. */
  JURY_SIZE_MAX: 99,
} as const);

/**
 * Keys that must never appear in a caller-supplied object, at any depth.
 *
 * A payload is data. These three names are how a data payload stops being data
 * the moment anything merges, clones or `Object.assign`s it into a prototype
 * chain. Rejecting them at the contract boundary is cheap and total; sanitising
 * them later depends on every consumer remembering to.
 *
 * One of the three behaves differently and it is worth knowing which, because
 * the list reads as though it were doing all the work: Zod removes an own
 * `__proto__` property from any input before a key schema or a strict-key check
 * ever sees it, so `__proto__` is DROPPED rather than rejected, and this list
 * never fires for it. The safety outcome is the same — nothing is polluted, and
 * the key cannot survive into parsed output — but a test asserting that
 * `__proto__` is *rejected* would fail, and a reader assuming this constant is
 * what prevents pollution would be assuming the wrong thing. `constructor` and
 * `prototype` are ordinary keys to Zod and are rejected here.
 */
export const FORBIDDEN_OBJECT_KEYS: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * An id that is local to one envelope, policy set or contract payload.
 *
 * Deliberately opaque: the plan writes both slugs (`app_mention`,
 * `mention.community`) and ULID-prefixed ids (`case_01...`) in the same fields,
 * so pinning the format would reject the plan's own reference documents. What
 * IS pinned is the character set — see the `:` note in the module comment.
 */
export const IdentifierSchema = z
  .string()
  .min(1)
  .max(CONTRACT_LIMITS.IDENTIFIER_MAX_LENGTH)
  .regex(
    IDENTIFIER_PATTERN,
    'must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
  );

/** An id minted by the reporting application, echoed back but never trusted. */
export const ExternalIdSchema = z
  .string()
  .min(1)
  .max(CONTRACT_LIMITS.EXTERNAL_ID_MAX_LENGTH)
  .regex(
    IDENTIFIER_PATTERN,
    'must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
  );

/**
 * `sha256:<64 lowercase hex>` — the ONLY accepted digest form.
 *
 * Appendix A writes `"sha256:..."`; §5.8 writes `"..."`. Accepting both would
 * let the same bytes be described two ways, and the canonical envelope hash
 * would differ between them (see property 1 in the module comment). Appendix A
 * is the reference document, so the prefixed form wins and the bare form is
 * rejected rather than silently normalised — normalising would mean the digest
 * CrowdSource stores is not the digest the application sent.
 */
export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'must be "sha256:" followed by 64 lowercase hex characters');

/**
 * Millisecond-precision UTC, e.g. `2026-07-28T18:00:00.000Z`.
 *
 * Every timestamp in the plan is written this way, and it is what
 * `Date.prototype.toISOString()` produces, so the canonical form costs a
 * JavaScript integrator nothing. Offsets are rejected: `18:00+02:00` and
 * `16:00Z` are the same instant and would hash differently.
 */
export const TimestampSchema = z.iso.datetime({ offset: false, precision: 3 });

/**
 * BCP 47, restricted to `language[-Script][-Region][-variant…]`.
 *
 * A syntactic subset, not the full grammar (no extensions, no private use, no
 * grandfathered tags). Covers `es` and `es-ES` from the plan and everything a
 * real application sends; a tag outside the subset is a signal worth rejecting
 * at ingress rather than carrying into reviewer language eligibility.
 */
export const LanguageTagSchema = z
  .string()
  .regex(
    /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?(-([0-9][A-Za-z0-9]{3}|[A-Za-z0-9]{5,8}))*$/,
    'must be a BCP 47 tag of the form language[-Script][-Region][-variant]',
  );

/**
 * An absolute `http`/`https` URL.
 *
 * §7.2.7 rejects "dangerous schemes and executable resources". Scheme is a
 * purely syntactic property, so the contract enforces it. Host reachability is
 * NOT enforced here: deciding whether a host is internal needs DNS resolution
 * and belongs to `safeFetch` at ingestion time. A scheme check that pretended
 * to be an SSRF control would be the more dangerous of the two.
 */
export const HttpUrlSchema = z.url({ protocol: /^https?$/ }).max(2_048);

/** A `type/subtype` media type, without parameters. */
export const MimeTypeSchema = z
  .string()
  .max(255)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
    'must be a lowercase "type/subtype" media type without parameters',
  );

const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** A key in any caller-supplied open bag. */
export const ObjectKeySchema = z
  .string()
  .min(1)
  .max(CONTRACT_LIMITS.METADATA_KEY_MAX_LENGTH)
  .regex(METADATA_KEY_PATTERN, 'must start with a letter and contain only letters, digits, ".", "_" or "-"')
  .refine((key) => !FORBIDDEN_OBJECT_KEYS.includes(key), {
    message: 'must not be a prototype-bearing key',
  });

/** A single metadata value: scalar only, never a nested structure. */
export const MetadataValueSchema = z.union([
  z.string().max(CONTRACT_LIMITS.METADATA_STRING_VALUE_MAX_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/**
 * An open key/value bag (§5.1 `metadata`, §5.3 the `metadata` resource type).
 *
 * Open by definition — the plan calls it "typed key value fields" and every
 * tenant's keys differ — but flat and bounded. Allowing nesting here would make
 * this the one field in the envelope through which an application could ship an
 * arbitrary document tree past every other constraint in the contract.
 */
export const MetadataBagSchema = z
  .record(ObjectKeySchema, MetadataValueSchema)
  .refine((bag) => Object.keys(bag).length <= CONTRACT_LIMITS.METADATA_KEYS_MAX, {
    message: `must not have more than ${CONTRACT_LIMITS.METADATA_KEYS_MAX} keys`,
  });

/** A JSON value that a §5.7 custom payload may contain. */
export type CustomPayloadValue =
  | string
  | number
  | boolean
  | null
  | CustomPayloadValue[]
  | { [key: string]: CustomPayloadValue };

const customPayloadScalarSchema = z.union([
  z.string().max(CONTRACT_LIMITS.CUSTOM_PAYLOAD_STRING_MAX_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const buildCustomPayloadValueSchema = (): z.ZodType<CustomPayloadValue> => {
  let value: z.ZodType<CustomPayloadValue> = customPayloadScalarSchema;
  for (let depth = 1; depth < CONTRACT_LIMITS.CUSTOM_PAYLOAD_MAX_DEPTH; depth += 1) {
    value = z.union([
      customPayloadScalarSchema,
      z.array(value).max(CONTRACT_LIMITS.CUSTOM_PAYLOAD_ARRAY_MAX_LENGTH),
      z.record(ObjectKeySchema, value),
    ]);
  }
  return value;
};

/**
 * The value grammar for a §5.7 custom payload.
 *
 * Nesting is unrolled to a fixed depth rather than made recursive so the bound
 * is part of the type, enforced by the same parse as everything else, and
 * visible in the exported JSON Schema. Depth is what stops a payload being a
 * document; `ObjectKeySchema` is what stops it being a prototype.
 *
 * Note what is deliberately absent: no lexical filter on string values. A
 * moderation payload legitimately carries the exact hostile text under review —
 * markup, script fragments, `javascript:` URLs quoted inside a harassment
 * report. Rejecting those strings would reject the material the system exists
 * to review. §5.7's boundary is structural, not lexical: the contract has no
 * field anywhere that carries markup, a template, a component or a remote URL
 * to be rendered, so there is nothing for such a string to be interpreted as.
 */
export const CustomPayloadValueSchema = buildCustomPayloadValueSchema();

/** The top level of a §5.7 custom payload: always an object, never an array. */
export const CustomPayloadSchema = z.record(ObjectKeySchema, CustomPayloadValueSchema);

/** A number in the closed interval [0, 1] — §9.5 clamps confidence to it. */
export const UnitIntervalSchema = z.number().min(0).max(1);

export type Identifier = z.infer<typeof IdentifierSchema>;
export type ExternalId = z.infer<typeof ExternalIdSchema>;
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type LanguageTag = z.infer<typeof LanguageTagSchema>;
export type MetadataBag = z.infer<typeof MetadataBagSchema>;
export type CustomPayload = z.infer<typeof CustomPayloadSchema>;
