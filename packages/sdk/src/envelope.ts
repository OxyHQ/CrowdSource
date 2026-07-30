/**
 * Composing a Case Envelope out of what an application already has.
 *
 * §5 is a rich document contract — resources with stable ids, relations between
 * them, pseudonymous principal bindings, digests, a policy reference, privacy
 * terms. Handing that to an integrator and asking them to fill it in is how a
 * moderation integration becomes a two-week project, and it is how the parts
 * that MATTER get filled in wrong: a random resource id or a per-report binding
 * proof inside the hashed projection means two people reporting the same post
 * open two cases, and "one penalty per incident" (Appendix F) fails in
 * production with nothing failing in a test.
 *
 * So the integrator describes the object — its id, its author, its text, its
 * attachments, what is alleged about it — and this module derives the rest:
 *
 *   * **Resource ids are positional and stable** (`res_subject`,
 *     `res_attachment_1`, `res_context_1`). Two reporters describing the same
 *     post through this SDK produce byte-identical resource lists, which is what
 *     makes §7.3's dedup key match.
 *   * **Principal refs are derived from the identity**, never generated. Same
 *     reason: the content snapshot the server hashes includes every principal
 *     the material points at, so a random ref would fragment the case.
 *   * **Digests are computed** (see `digest.ts`).
 *   * **Relations are derived** from the role each resource was given.
 *   * **The binding proof is the Oxy `sub`.** §11.14 requires proof that a
 *     pseudonymous ref corresponds to a real identity before anything can touch
 *     Oxy Trust. Sign in with Oxy already produced exactly that: a subject
 *     issued for this `applicationId`. There is no separate binding step to
 *     implement, and this module does not invent one.
 *   * **`applicationId` comes from the credential** (see `credential.ts`). No
 *     input on this page can carry one.
 */

import {
  CaseEnvelopeSchema,
  CASE_ENVELOPE_SCHEMA_VERSION,
  type Allegation,
  type CaseEnvelope,
  type CasePolicyRef,
  type CasePrivacy,
  type CaseUrgency,
  type MetadataBag,
  type PrincipalBinding,
  type PrincipalType,
  type Relation,
  type Resource,
  type SubjectType,
  type TaxonomyCode,
} from '@oxyhq/crowdsource-contracts';

import { DEFAULT_POLICY, allegationsForbiddingCommunityReview, defaultPrivacy } from './defaults.js';
import { canonicalJson, resourceDigest, sha256Digest, type CanonicalValue } from './digest.js';
import { CrowdSourceError } from './errors.js';

/** `Omit` that survives a discriminated union instead of collapsing it. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * A resource as an integrator describes it: the material, without the envelope
 * plumbing.
 *
 * Derived from the published `Resource` union rather than restated, so a
 * resource type added to the contract is available here the moment the
 * contracts dependency is bumped, and a field removed from it stops compiling
 * on the next build instead of being silently ignored at ingress.
 */
export type ResourceInput = DistributiveOmit<
  Resource,
  'id' | 'role' | 'sha256' | 'authorPrincipalRef' | 'createdAt'
> & {
  /** The moment of the ORIGINAL object, not of the report (§5.2). */
  readonly createdAt?: Date | string;
};

/** Why a context resource is attached to the subject (§5.5). */
export type ContextRole = 'parent' | 'quoted' | 'context' | 'evidence';

export type ContextInput = ResourceInput & { readonly role: ContextRole };

/**
 * A person or account, as the application knows them.
 *
 * `oxyUserId` is the OAuth `sub` from Sign in with Oxy. Supplying it is what
 * makes an actor addressable by Oxy Trust at all — §11.14 admits no effect
 * without a binding proof, and the `sub` issued for this application IS that
 * proof. `id` is the application's own identifier for the same actor, for
 * applications that keep their own user table; it is what a reviewer's
 * pseudonymous ref is derived from and never shown to a jury.
 */
export interface PrincipalInput {
  readonly oxyUserId?: string;
  readonly id?: string;
  /** Defaults to `oxy_user` with an `oxyUserId`, `local_user` without one. */
  readonly type?: PrincipalType;
}

/** What the reporter claims, not what is true (§6.2). */
export interface AllegationInput {
  readonly code: TaxonomyCode;
  /** The reporter's own words. Never shown as evidence of the claim. */
  readonly details?: string;
}

export interface ReportSubjectInput {
  /** The application's own id for the object being reported. */
  readonly externalId: string;
  /** §5.4, e.g. `social.post` or `custom.<organization>.<object_type>`. */
  readonly type: SubjectType;
  /** Where the application's own users see it. Never fetched by a jury. */
  readonly permalink?: string;
  readonly author?: PrincipalInput;
}

export interface ReportInput {
  /** The application's own report id. Also the default idempotency key. */
  readonly externalReportId: string;
  readonly subject: ReportSubjectInput;
  /** The reported material. A string is shorthand for a plain-text resource. */
  readonly content: string | ResourceInput;
  readonly attachments?: readonly ResourceInput[];
  /** Replies, quotes, surrounding messages — context without extra exposure. */
  readonly context?: readonly ContextInput[];
  readonly allegations: readonly (TaxonomyCode | AllegationInput)[];
  /** Who reported it. Omit for a report the application raised itself. */
  readonly reportedBy?: PrincipalInput;
  /** Defaults to the pinned baseline policy version — see `defaults.ts`. */
  readonly policy?: CasePolicyRef;
  readonly privacy?: Partial<CasePrivacy>;
  readonly urgency?: CaseUrgency;
  readonly metadata?: MetadataBag;
  /**
   * When the USER reported it (§5.1 `source.submittedAt`) — the timestamp on the
   * application's own outbox row, not the moment of delivery.
   *
   * There is no default, and that is load-bearing rather than an omission. The
   * ingress fingerprints the whole `{ externalReportId, envelope }` to detect
   * §10.5's "external id reused with different content", so ANY value this
   * client invented per attempt would make a legitimate retry from an outbox a
   * permanent 409 — the failure would appear as moderation work silently
   * stuck in a delivery queue, days after the integration was written. Omitted
   * when absent: §5.1 makes `source` optional and §5.8 leaves it out.
   */
  readonly submittedAt?: Date | string;
  /** Appendix D. Defaults to `report.<externalReportId>`. */
  readonly idempotencyKey?: string;
}

/** Raised when an input cannot become a valid envelope. Never retryable. */
export class CrowdSourceReportInputError extends CrowdSourceError {
  constructor(message: string) {
    super(message, false);
  }
}

/** How the application declares its own environment (§5.1 `source`). */
export type SourceEnvironment = 'production' | 'sandbox';

export interface EnvelopeComposition {
  readonly applicationId: string;
  readonly environment: SourceEnvironment;
}

const SUBJECT_RESOURCE_ID = 'res_subject';

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * A principal ref derived from the identity, so it is the same value for every
 * reporter.
 *
 * Opaque on purpose: §9.1 keeps identities away from the jury, and a ref that
 * embedded a username would put one on the reviewer's screen. Truncated to 128
 * bits, which is far past any collision risk within one envelope's 50-binding
 * ceiling and keeps the ref short enough to read in a case document.
 */
function principalRef(type: PrincipalType, identity: string): string {
  return `p_${sha256Digest(canonicalJson([type, identity])).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

interface ResolvedPrincipal {
  readonly ref: string;
  readonly binding: PrincipalBinding;
}

function resolvePrincipal(input: PrincipalInput, role: string): ResolvedPrincipal {
  const type: PrincipalType =
    input.type ?? (input.oxyUserId === undefined ? 'local_user' : 'oxy_user');

  if (type === 'oxy_user' && input.oxyUserId === undefined) {
    throw new CrowdSourceReportInputError(
      `The ${role} is declared as an oxy_user but carries no oxyUserId. The Oxy subject IS the binding proof (§11.14); without it there is nothing to bind.`,
    );
  }

  const externalPrincipalId = input.id ?? input.oxyUserId;
  if (externalPrincipalId === undefined) {
    throw new CrowdSourceReportInputError(
      `The ${role} carries neither an oxyUserId nor an id, so there is no identity to reference.`,
    );
  }

  const ref = principalRef(type, externalPrincipalId);
  return {
    ref,
    binding: {
      principalRef: ref,
      type,
      externalPrincipalId,
      /**
       * The `sub` itself. §11.14 asks for proof that this ref is that identity,
       * and an OAuth subject issued to this application for this user is that
       * proof — it is not a receipt POINTING at one. Deliberately absent for
       * every other principal type: they have no Oxy identity to move, and
       * requiring a proof from them would lock out every tenant whose users are
       * not Oxy users.
       */
      ...(type === 'oxy_user' && input.oxyUserId !== undefined
        ? { bindingProofId: input.oxyUserId }
        : {}),
    },
  };
}

/** The object a resource's digest is taken over — see `digest.ts`. */
function reviewableRepresentation(resource: ResourceInput): CanonicalValue {
  if (resource.type === 'custom') {
    return { type: resource.type, schemaId: resource.schemaId, data: resource.payload };
  }
  return { type: resource.type, data: 'data' in resource ? resource.data : null };
}

/**
 * Turns one described resource into a contract resource.
 *
 * The digest is the only field invented here. An asset-backed resource does not
 * get one: its bytes are outside the envelope and `asset.sha256` already
 * identifies them, which is the split the contract makes.
 *
 * Returns `unknown` rather than `Resource`, deliberately. The value is assembled
 * from caller data and only becomes a `Resource` when `CaseEnvelopeSchema`
 * parses it at the end of `composeCaseEnvelope`. Declaring it a `Resource` here
 * would need a cast, and a cast is a claim the type system cannot check — the
 * parse is what actually establishes it.
 */
function composeResource(
  input: ResourceInput,
  id: string,
  role: Resource['role'],
  authorPrincipalRef: string | undefined,
): unknown {
  const { createdAt, ...rest } = input;

  return {
    ...rest,
    id,
    role,
    ...(createdAt === undefined ? {} : { createdAt: isoTimestamp(createdAt) }),
    ...(authorPrincipalRef === undefined ? {} : { authorPrincipalRef }),
    ...('asset' in input ? {} : { sha256: resourceDigest(reviewableRepresentation(input)) }),
  };
}

const CONTEXT_RELATIONS: Readonly<Record<ContextRole, Relation['type']>> = Object.freeze({
  parent: 'replies_to',
  quoted: 'quotes',
  context: 'contextualizes',
  evidence: 'refers_to',
});

function normalisedAllegations(
  input: readonly (TaxonomyCode | AllegationInput)[],
): readonly AllegationInput[] {
  return input.map((entry) => (typeof entry === 'string' ? { code: entry } : entry));
}

/**
 * Composes and VALIDATES a Case Envelope.
 *
 * The parse at the end is not belt-and-braces. Everything above assembles a
 * document from caller data — a subject type, a text body, an asset digest —
 * and the contract is where a bad one is caught. Catching it here means the
 * integrator sees the field and the reason at the call site, in their own
 * process, instead of reading a 422 out of a delivery worker's log an hour
 * later.
 */
export function composeCaseEnvelope(
  input: ReportInput,
  composition: EnvelopeComposition,
): CaseEnvelope {
  if (input.submittedAt === undefined && composition.environment === 'sandbox') {
    throw new CrowdSourceReportInputError(
      'A sandbox report must declare submittedAt: the environment travels in `source`, and `source` cannot be composed without a submission time this client would otherwise have to invent — which would make every retry of this report a 409.',
    );
  }

  const allegations = normalisedAllegations(input.allegations);
  const allegationCodes = allegations.map((allegation) => allegation.code);

  const bindings: PrincipalBinding[] = [];
  const rememberPrincipal = (principal: ResolvedPrincipal): string => {
    if (!bindings.some((binding) => binding.principalRef === principal.ref)) {
      bindings.push(principal.binding);
    }
    return principal.ref;
  };

  const authorRef =
    input.subject.author === undefined
      ? undefined
      : rememberPrincipal(resolvePrincipal(input.subject.author, 'subject author'));
  const reporterRef =
    input.reportedBy === undefined
      ? undefined
      : rememberPrincipal(resolvePrincipal(input.reportedBy, 'reporter'));

  const subjectContent: ResourceInput =
    typeof input.content === 'string'
      ? { type: 'text', data: { text: input.content } }
      : input.content;

  const resources: unknown[] = [
    composeResource(subjectContent, SUBJECT_RESOURCE_ID, 'subject', authorRef),
  ];
  const relations: Relation[] = [];

  (input.attachments ?? []).forEach((attachment, index) => {
    const id = `res_attachment_${index + 1}`;
    resources.push(composeResource(attachment, id, 'attachment', authorRef));
    relations.push({ from: SUBJECT_RESOURCE_ID, type: 'has_attachment', to: id });
  });

  (input.context ?? []).forEach((entry, index) => {
    const id = `res_context_${index + 1}`;
    const { role, ...resource } = entry;
    resources.push(composeResource(resource, id, role, undefined));
    relations.push(
      role === 'context'
        ? { from: id, type: CONTEXT_RELATIONS[role], to: SUBJECT_RESOURCE_ID }
        : { from: SUBJECT_RESOURCE_ID, type: CONTEXT_RELATIONS[role], to: id },
    );
  });

  const privacy = resolvePrivacy(input.privacy, allegationCodes);

  const envelope: unknown = {
    schemaVersion: CASE_ENVELOPE_SCHEMA_VERSION,
    applicationId: composition.applicationId,
    externalReportId: input.externalReportId,
    ...(input.submittedAt === undefined
      ? {}
      : {
          source: {
            environment: composition.environment,
            submittedAt: isoTimestamp(input.submittedAt),
          },
        }),
    subject: {
      externalId: input.subject.externalId,
      type: input.subject.type,
      primaryResourceId: SUBJECT_RESOURCE_ID,
      ...(input.subject.permalink === undefined ? {} : { permalink: input.subject.permalink }),
    },
    principalBindings: bindings,
    resources,
    relations,
    allegations: allegations.map(
      (allegation): Allegation => ({
        code: allegation.code,
        ...(allegation.details === undefined ? {} : { details: allegation.details }),
        ...(reporterRef === undefined ? {} : { reporterPrincipalRef: reporterRef }),
      }),
    ),
    policy: input.policy ?? DEFAULT_POLICY,
    privacy,
    ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };

  const parsed = CaseEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new CrowdSourceReportInputError(
      `This report cannot be composed into a valid Case Envelope — ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * Privacy terms, with §7.5's routing rule as a floor the caller cannot lift.
 *
 * An explicit `allowCommunityReview: true` alongside an allegation §7.5 keeps
 * away from a community jury is REFUSED, not corrected. Correcting it would
 * leave the application believing it had asked for something it did not get,
 * and the next thing built on that belief would be wrong too.
 */
function resolvePrivacy(
  requested: Partial<CasePrivacy> | undefined,
  allegationCodes: readonly TaxonomyCode[],
): CasePrivacy {
  const base = defaultPrivacy(allegationCodes);
  if (requested === undefined) return base;

  const forbidden = allegationsForbiddingCommunityReview(allegationCodes);
  if (requested.allowCommunityReview === true && forbidden.length > 0) {
    throw new CrowdSourceReportInputError(
      `A report alleging ${forbidden.join(', ')} cannot set allowCommunityReview: true — §7.5 routes this material to a specialist team, never to a community jury.`,
    );
  }

  return {
    ...base,
    ...(requested.retentionDays === undefined ? {} : { retentionDays: requested.retentionDays }),
    ...(requested.allowCommunityReview === undefined
      ? {}
      : { allowCommunityReview: requested.allowCommunityReview }),
    ...(requested.containsPersonalData === undefined
      ? {}
      : { containsPersonalData: requested.containsPersonalData }),
    ...(requested.sensitivityHint === undefined
      ? {}
      : { sensitivityHint: requested.sensitivityHint }),
  };
}

/** Appendix D: the same report re-delivered must return the same `reportId`. */
export function defaultIdempotencyKey(externalReportId: string): string {
  return `report.${externalReportId}`;
}
