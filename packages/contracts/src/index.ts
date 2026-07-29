/**
 * Public entry point for `@oxyhq/crowdsource-contracts`.
 *
 * The contracts every CrowdSource surface agrees on: the backend, the reviewer
 * and console clients, the published SDKs, and third-party integrators. One
 * entry point because the package publishes one `exports` path — this is the
 * package boundary, not a convenience barrel over an internal tree.
 *
 * Two version numbers live here and mean different things. `/v1` is the route
 * prefix and is not this package's business. `CASE_ENVELOPE_SCHEMA_VERSION`
 * travels inside the payload and is validated separately (§10.11). Additive
 * changes bump neither.
 *
 * Where strictness lands, and why, since it is the one thing a reader will want
 * to look up:
 *
 *   * **Inbound from a tenant or a reviewer — strict.** The Case Envelope tree,
 *     the review submission, the recusal, the policy set, the resource schema
 *     registration. A dropped field here is context a jury never sees or an
 *     input nobody reviewed, and §10.11 makes the exception explicitly for
 *     fields "the schema forbids for safety".
 *   * **Outbound to a tenant — loose.** Decisions, webhook envelopes and event
 *     payloads pass unknown fields through, so a newer CrowdSource never breaks
 *     an older client and a receiver that persists `event.data` keeps all of it.
 *   * **Internal, to Oxy Trust — strict.** The reputation event carries no
 *     resource ids and no free text on purpose; an unrecognised field is how
 *     content reaches a reputation ledger. The `.v1` in the event type is what
 *     handles evolution there.
 *
 * Open bags (`metadata`, custom payloads, registered JSON Schemas) are the
 * deliberate exception in both directions: open by definition, but flat or
 * depth-bounded, scalar-typed, key-restricted and free of prototype-bearing
 * names.
 */

export * from './closed';
export * from './primitives';
export * from './taxonomy';
export * from './policies';
export * from './resources';
export * from './case-envelope';
export * from './reviews';
export * from './reviewer-surface';
export * from './decisions';
export * from './appeals';
export * from './webhooks';
export * from './reputation-events';
export * from './json-schema';
