/**
 * `@oxyhq/crowdsource` — the TypeScript client for the CrowdSource moderation
 * API.
 *
 * The smallest integration this package supports, in full:
 *
 * ```ts
 * import { CrowdSource } from '@oxyhq/crowdsource';
 *
 * const crowdsource = new CrowdSource();
 *
 * await crowdsource.reports.create({
 *   externalReportId: report.id,
 *   reportedBy: { oxyUserId: session.sub },
 *   subject: {
 *     externalId: post.id,
 *     type: 'social.post',
 *     author: { oxyUserId: post.authorId },
 *   },
 *   content: post.text,
 *   allegations: ['harassment.targeted_abuse'],
 * });
 * ```
 *
 * One environment variable (`CROWDSOURCE_SERVICE_KEY`) and the object being
 * reported. The Case Envelope, its resource ids, its digests, its relations, its
 * principal bindings, the identity binding proof, the policy version, the
 * retention terms and the idempotency key are all composed from that — see
 * `envelope.ts` for what each one is derived from and why it cannot be left to
 * the caller.
 *
 * Types come from `@oxyhq/crowdsource-contracts`. This package re-exports none
 * of them: an integrator imports the contract from the contract package, so a
 * `Decision` or a `TaxonomyCode` has exactly one definition.
 */

export { CrowdSource, SERVICE_KEY_ENV_VAR, BASE_URL_ENV_VAR } from './client';
export type { CrowdSourceOptions } from './client';

export { formatServiceKey, parseServiceKey } from './credential';
export type { ServiceCredential } from './credential';

export {
  COMMUNITY_REVIEW_FORBIDDEN_ALLEGATIONS,
  DEFAULT_BASE_URL,
  DEFAULT_POLICY,
  DEFAULT_RETENTION_DAYS,
} from './defaults';

export { canonicalJson, resourceDigest, sha256Digest } from './digest';
export type { CanonicalValue } from './digest';

/**
 * `composeCaseEnvelope` is deliberately NOT exported.
 *
 * It is the one function in this package that takes an `applicationId`, and it
 * takes it from `Reports`, which got it from the credential. Exporting it would
 * put an `applicationId` parameter on the public surface — which is the thing
 * Appendix F says must not exist, however carefully the doc comment above it
 * were worded. The envelope a report produces is reachable by reading what
 * `reports.create` sends, not by building one yourself.
 */
export { CrowdSourceReportInputError, defaultIdempotencyKey } from './envelope';
export type {
  AllegationInput,
  ContextInput,
  ContextRole,
  PrincipalInput,
  ReportInput,
  ReportSubjectInput,
  ResourceInput,
} from './envelope';

export {
  CROWDSOURCE_API_ERROR_CODES,
  CrowdSourceApiError,
  CrowdSourceConfigurationError,
  CrowdSourceError,
  CrowdSourceTransportError,
  isCrowdSourceApiError,
  isCrowdSourceApiErrorCode,
  isCrowdSourceError,
} from './errors';
export type { CrowdSourceApiErrorCode } from './errors';

export { Reports } from './reports';
export type { ReportReceipt, ReportRequestOptions } from './reports';

export { Cases, Decisions } from './cases';
export type { CaseView, ReadOptions } from './cases';

export { Uploads } from './uploads';
export type { EvidenceAsset, UploadInput } from './uploads';

export { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS } from './transport';
export type { FetchLike } from './transport';
