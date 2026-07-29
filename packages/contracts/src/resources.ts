/**
 * Resources and relations — the universal content unit (§5.2–§5.7).
 *
 * "Applications send data, never executable code" (§5.2). Everything in this
 * module follows from that one sentence:
 *
 *   * The resource union is CLOSED and discriminated on `type`, and each
 *     variant declares exactly which fields it may carry. There is no free-form
 *     branch, so there is no place to put a rendering instruction.
 *   * Every object is `.strict()`. In the outbound direction an unknown field
 *     is harmless forward compatibility (§10.11); inbound it is not. A field
 *     that is silently dropped is context an application believes it sent and a
 *     jury never sees — which is how a case gets decided on incomplete material
 *     — and a field that is silently kept is a rendering input nobody reviewed.
 *     §10.11 makes exactly this exception: unknown fields must not break
 *     clients "except where the schema forbids them for safety".
 *   * A media type must agree with its resource type, so an `image` cannot
 *     declare `text/html` and be handed to something that trusts the label.
 *   * §5.7 custom payloads are bounded JSON with no `$`-prefixed keys, which
 *     removes every JSON Schema reference mechanism at once — `$ref` to a
 *     remote document IS the "remote component" §5.7 forbids, and resolving one
 *     is an SSRF against CrowdSource itself.
 *
 * What is deliberately NOT here: any filter on the CONTENT of text fields. The
 * material under review is hostile by definition — a harassment report quotes
 * the harassment, a phishing report quotes the phishing link. A lexical
 * blocklist would reject the evidence and protect nothing, because the contract
 * has no field whose value is ever interpreted as markup or code.
 */

import { z } from 'zod';

import {
  CONTRACT_LIMITS,
  CustomPayloadSchema,
  HttpUrlSchema,
  IdentifierSchema,
  LanguageTagSchema,
  MetadataBagSchema,
  MimeTypeSchema,
  OxyFileIdSchema,
  Sha256DigestSchema,
  TimestampSchema,
} from './primitives';
import { PolicyVersionSchema } from './policies';
import { SensitivityHintSchema } from './taxonomy';

/** A resource id, unique within one envelope (§5.2 `id`). */
export const ResourceIdSchema = IdentifierSchema;
export type ResourceId = z.infer<typeof ResourceIdSchema>;

/**
 * A pseudonymous reference to an actor, resolved within one envelope.
 *
 * Never a real identity: §13.5 requires a pseudonymous principal wherever one
 * suffices. `principalBindings` is the only place a ref is tied to anything,
 * and even there it is tied to a binding proof id, not to a name.
 */
export const PrincipalRefSchema = IdentifierSchema;
export type PrincipalRef = z.infer<typeof PrincipalRefSchema>;

/** §5.2 `role`: why this resource is in the case. */
export const RESOURCE_ROLES = [
  'subject',
  'attachment',
  'context',
  'parent',
  'quoted',
  'evidence',
  'metadata',
  'policy_context',
] as const;
export const ResourceRoleSchema = z.enum(RESOURCE_ROLES);
export type ResourceRole = z.infer<typeof ResourceRoleSchema>;

/** §5.3 standard resource types. */
export const RESOURCE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'link',
  'profile',
  'conversation',
  'listing',
  'location',
  'metadata',
  'custom',
] as const;
export const ResourceTypeSchema = z.enum(RESOURCE_TYPES);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;

/** §5.3 text formatting. Never HTML: `markdown_subset` is a subset for a reason. */
export const TEXT_FORMATTINGS = ['plain', 'markdown_subset'] as const;
export const TextFormattingSchema = z.enum(TEXT_FORMATTINGS);
export type TextFormatting = z.infer<typeof TextFormattingSchema>;

/**
 * A reference to bytes held outside the envelope (§5.2 `asset`).
 *
 * **`fileId` is where the bytes are. `url` is where they came from.** Those are
 * not alternatives, and the earlier contract encoding them as "exactly one of
 * `uploadId` or `url`" is what left an integrator with no safe way to attach an
 * image at all: the `uploadId` branch needed a presigned upload route that was
 * superseded by the Oxy media chokepoint before it was ever built, and the `url`
 * branch put a URL on the reporting application's own host in front of a
 * reviewer — breaking §9.1's branding rule and the chokepoint rule at once.
 *
 * So `fileId` is required and `url` is optional provenance:
 *
 *   * **`fileId`** — a bare Oxy file id. The application uploads the bytes
 *     through the Oxy media chokepoint with its own Oxy credentials and passes
 *     the id. That is why CrowdSource serves no upload route of its own.
 *   * **`url`** — a PROVENANCE RECORD, and never a fetch target. A third-party
 *     URL is not wrong the way a first-party one is (a federated post's image
 *     genuinely lives elsewhere), but no reviewer client may dereference it:
 *     fetching it would tell that host exactly when its content is under review,
 *     which lets the reported party correlate reviewer accesses, and it would
 *     deliver bytes live rather than the pinned ones §5.6 requires.
 *
 * `sha256` stays required, and requiring `fileId` alongside it costs an
 * integrator nothing new — an application able to compute that digest already
 * holds the bytes. What changes is that it puts bytes it already has somewhere a
 * reviewer can read safely, instead of pointing at its own host.
 */
export const AssetRefSchema = z.strictObject({
  /** Bare Oxy file id. The only source of the bytes a jury sees. */
  fileId: OxyFileIdSchema,
  /** Where the material was found. Recorded, never fetched — see above. */
  url: HttpUrlSchema.optional(),
  mimeType: MimeTypeSchema,
  sha256: Sha256DigestSchema,
  sizeBytes: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

const mediaTypeMismatch = (
  ctx: z.RefinementCtx,
  mimeType: string,
  allowedPrefixes: readonly string[],
): void => {
  if (!allowedPrefixes.some((prefix) => mimeType.startsWith(prefix))) {
    ctx.addIssue({
      code: 'custom',
      path: ['asset', 'mimeType'],
      message: `must be one of ${allowedPrefixes.join(', ')}* for this resource type`,
    });
  }
};

const resourceBaseShape = {
  id: ResourceIdSchema,
  role: ResourceRoleSchema,
  /** §5.2: BCP 47 "where applicable" — a text of unknown language is real. */
  language: LanguageTagSchema.optional(),
  /** §5.2: the moment of the ORIGINAL object, not of the report. */
  createdAt: TimestampSchema.optional(),
  authorPrincipalRef: PrincipalRefSchema.optional(),
  /** §5.2: a prior classification of exposure, never shown as a verdict. */
  sensitivity: SensitivityHintSchema.optional(),
};

/**
 * `sha256` is required on every resource whose content travels inline, and
 * optional on asset-backed ones where `asset.sha256` carries it instead.
 *
 * That split is not a preference; it is what both reference envelopes do.
 * Appendix A's `res_post` and `res_parent` carry a top-level digest and its
 * `res_image` carries the digest on the asset only. §5.6 asks for "SHA 256 of
 * each resource", so one of the two is always present.
 */
const inlineResourceShape = { ...resourceBaseShape, sha256: Sha256DigestSchema };
const assetResourceShape = { ...resourceBaseShape, sha256: Sha256DigestSchema.optional() };

const TextResourceSchema = z.strictObject({
  ...inlineResourceShape,
  type: z.literal('text'),
  data: z.strictObject({
    text: z.string().min(1).max(CONTRACT_LIMITS.TEXT_RESOURCE_MAX_LENGTH),
    formatting: TextFormattingSchema.optional(),
  }),
});

const ImageResourceSchema = z
  .strictObject({
    ...assetResourceShape,
    type: z.literal('image'),
    asset: AssetRefSchema,
  })
  .superRefine((resource, ctx) => mediaTypeMismatch(ctx, resource.asset.mimeType, ['image/']));

const VideoResourceSchema = z
  .strictObject({
    ...assetResourceShape,
    type: z.literal('video'),
    asset: AssetRefSchema,
    data: z
      .strictObject({
        timeRange: z
          .strictObject({
            startSeconds: z.number().nonnegative(),
            endSeconds: z.number().positive(),
          })
          .refine((range) => range.endSeconds > range.startSeconds, {
            message: 'endSeconds must be greater than startSeconds',
            path: ['endSeconds'],
          })
          .optional(),
      })
      .optional(),
  })
  .superRefine((resource, ctx) => {
    mediaTypeMismatch(ctx, resource.asset.mimeType, ['video/']);
    if (resource.asset.durationSeconds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['asset', 'durationSeconds'],
        message: 'a video asset must declare durationSeconds',
      });
    }
  });

const AudioResourceSchema = z
  .strictObject({
    ...assetResourceShape,
    type: z.literal('audio'),
    asset: AssetRefSchema,
    data: z
      .strictObject({
        transcript: z.string().max(CONTRACT_LIMITS.EXTRACTED_TEXT_MAX_LENGTH).optional(),
      })
      .optional(),
  })
  .superRefine((resource, ctx) => {
    mediaTypeMismatch(ctx, resource.asset.mimeType, ['audio/']);
    if (resource.asset.durationSeconds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['asset', 'durationSeconds'],
        message: 'an audio asset must declare durationSeconds',
      });
    }
  });

const DocumentResourceSchema = z
  .strictObject({
    ...assetResourceShape,
    type: z.literal('document'),
    asset: AssetRefSchema,
    data: z.strictObject({
      title: z.string().min(1).max(CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH),
      extractedText: z.string().max(CONTRACT_LIMITS.EXTRACTED_TEXT_MAX_LENGTH).optional(),
    }),
  })
  .superRefine((resource, ctx) =>
    mediaTypeMismatch(ctx, resource.asset.mimeType, ['application/', 'text/']),
  );

const LinkResourceSchema = z.strictObject({
  ...inlineResourceShape,
  type: z.literal('link'),
  data: z.strictObject({
    url: HttpUrlSchema,
    title: z.string().max(CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH).optional(),
    resolvedHost: z
      .string()
      .max(253)
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'must be a hostname')
      .optional(),
    snapshot: z.string().max(CONTRACT_LIMITS.EXTRACTED_TEXT_MAX_LENGTH).optional(),
  }),
});

const ProfileResourceSchema = z.strictObject({
  ...inlineResourceShape,
  type: z.literal('profile'),
  data: z.strictObject({
    /**
     * Every field is optional on purpose. A federated or unresolved actor
     * routinely has no display name, and requiring one would push applications
     * into synthesising a name — the opposite of what the profile-identity rule
     * in the ecosystem instructions asks for.
     */
    displayName: z.string().max(CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH).optional(),
    bio: z.string().max(CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH).optional(),
    /** An `image` resource in the same envelope. */
    avatarRef: ResourceIdSchema.optional(),
    claims: MetadataBagSchema.optional(),
  }),
});

const ConversationResourceSchema = z.strictObject({
  ...inlineResourceShape,
  type: z.literal('conversation'),
  data: z.strictObject({
    /**
     * Ordered (§5.3). §13.5 asks for five messages around the incident rather
     * than the whole thread, which is why this is a bounded list of ids the
     * application chose, not a pointer to a conversation.
     */
    messageResourceIds: z
      .array(ResourceIdSchema)
      .min(1)
      .max(CONTRACT_LIMITS.CONVERSATION_MESSAGES_MAX),
  }),
});

const ListingResourceSchema = z
  .strictObject({
    ...inlineResourceShape,
    type: z.literal('listing'),
    data: z.strictObject({
      title: z.string().min(1).max(CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH),
      description: z.string().max(CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH).optional(),
      price: z.number().finite().nonnegative().optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/, 'must be an ISO 4217 alphabetic code')
        .optional(),
      sellerRef: PrincipalRefSchema.optional(),
      mediaRefs: z.array(ResourceIdSchema).max(CONTRACT_LIMITS.LISTING_MEDIA_REFS_MAX).optional(),
    }),
  })
  .superRefine((resource, ctx) => {
    const hasPrice = resource.data.price !== undefined;
    const hasCurrency = resource.data.currency !== undefined;
    if (hasPrice !== hasCurrency) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', hasPrice ? 'currency' : 'price'],
        message: 'price and currency must travel together',
      });
    }
  });

/** Two decimal places ≈ 1.1 km — coarse enough not to locate a person. */
const COARSE_COORDINATE_DECIMALS = 2;

const isCoarse = (value: number): boolean =>
  Number.isInteger(value * 10 ** COARSE_COORDINATE_DECIMALS);

const LocationResourceSchema = z
  .strictObject({
    ...inlineResourceShape,
    type: z.literal('location'),
    data: z.strictObject({
      label: z.string().max(CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
    }),
  })
  .superRefine((resource, ctx) => {
    const { label, latitude, longitude } = resource.data;
    if (label === undefined && latitude === undefined && longitude === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'a location must carry a label, coordinates, or both',
      });
    }
    if ((latitude === undefined) !== (longitude === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', latitude === undefined ? 'latitude' : 'longitude'],
        message: 'latitude and longitude must travel together',
      });
    }
    /**
     * §5.3 says "coarse location or place label" and §13.5 requires precise
     * location to be redacted before community review. Precision is a property
     * of the number itself, so the contract can refuse the precise value rather
     * than trusting every downstream renderer to round it.
     */
    if (latitude !== undefined && !isCoarse(latitude)) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'latitude'],
        message: `must be coarse: at most ${COARSE_COORDINATE_DECIMALS} decimal places`,
      });
    }
    if (longitude !== undefined && !isCoarse(longitude)) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'longitude'],
        message: `must be coarse: at most ${COARSE_COORDINATE_DECIMALS} decimal places`,
      });
    }
  });

const MetadataResourceSchema = z.strictObject({
  ...inlineResourceShape,
  type: z.literal('metadata'),
  data: MetadataBagSchema.refine((bag) => Object.keys(bag).length >= 1, {
    message: 'a metadata resource must carry at least one field',
  }),
});

const CustomResourceSchema = z.strictObject({
  ...inlineResourceShape,
  type: z.literal('custom'),
  /** The schema the application registered for this shape (§5.7). */
  schemaId: IdentifierSchema,
  /**
   * Validated twice: structurally here, then against the registered JSON Schema
   * at ingress. The registered schema decides what the fields MEAN; this decides
   * that they are fields at all.
   */
  payload: CustomPayloadSchema,
});

/**
 * One resource (§5.2).
 *
 * A discriminated union rather than one object with everything optional: the
 * latter would accept an `image` with inline text and no asset, which is not a
 * resource anybody can review.
 */
export const ResourceSchema = z.discriminatedUnion('type', [
  TextResourceSchema,
  ImageResourceSchema,
  VideoResourceSchema,
  AudioResourceSchema,
  DocumentResourceSchema,
  LinkResourceSchema,
  ProfileResourceSchema,
  ConversationResourceSchema,
  ListingResourceSchema,
  LocationResourceSchema,
  MetadataResourceSchema,
  CustomResourceSchema,
]);
export type Resource = z.infer<typeof ResourceSchema>;

/** §5.5 relation types. */
export const RELATION_TYPES = [
  'has_attachment',
  'replies_to',
  'quotes',
  'authored_by',
  'contextualizes',
  'previous_version',
  'contains',
  'refers_to',
] as const;
export const RelationTypeSchema = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof RelationTypeSchema>;

/**
 * Relation types whose `to` names a principal rather than a resource.
 *
 * §5.5 defines `authored_by` as "a resource was created by a principal", so its
 * target is a `principalRef`. Every other relation in the table joins two
 * resources. No example in the plan exercises `authored_by`, so this reading is
 * recorded here rather than assumed: it is what makes §5.5's "the backend must
 * validate that every referenced id exists in the envelope" checkable at all,
 * since the two id spaces are separate.
 */
export const PRINCIPAL_TARGETED_RELATION_TYPES = ['authored_by'] as const;

/**
 * A relation (§5.5).
 *
 * `from` and `to` are only shape-checked here. Whether they RESOLVE is decided
 * by `CaseEnvelopeSchema`, which is the smallest scope that can see both the
 * resource list and the principal list.
 */
export const RelationSchema = z.strictObject({
  from: ResourceIdSchema,
  type: RelationTypeSchema,
  to: IdentifierSchema,
});
export type Relation = z.infer<typeof RelationSchema>;

/**
 * A custom resource schema an application registers (§5.7).
 *
 * `jsonSchema` reuses the custom-payload grammar, which forbids `$`-prefixed
 * keys. That single restriction removes `$ref`, `$dynamicRef`, `$recursiveRef`
 * and `$id` in one move — every mechanism by which a registered schema could
 * point at a document CrowdSource would then have to fetch. §5.7's "no remote
 * components" is not a rendering rule alone; a remote `$ref` is also an SSRF
 * with a tenant holding the pen.
 *
 * The cost is `$defs`, `$schema` and `$comment`, which flat custom-field
 * schemas do not need. Recursive tenant schemas are not supported and are not
 * meant to be.
 */
export const ResourceSchemaRegistrationSchema = z.strictObject({
  schemaId: IdentifierSchema,
  version: PolicyVersionSchema,
  title: z.string().min(1).max(CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH),
  description: z.string().max(CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH).optional(),
  jsonSchema: CustomPayloadSchema,
});
export type ResourceSchemaRegistration = z.infer<typeof ResourceSchemaRegistrationSchema>;
