# ADR 0002 — One universal Case Envelope, versioned, and what it refuses to carry

- **Status**: accepted
- **Date**: 2026-07-30
- **Implemented in**: `packages/contracts/src` (`case-envelope.ts`, `resources.ts`, `primitives.ts`, `policies.ts`)

## Context

CrowdSource is moderation infrastructure for applications it has never seen. The
first application is a social network, so the tempting shape is a `post`, a
`comment`, an `author` and a `reporter`. §5 opens by naming that as the principal
mistake to avoid, and it is worth being explicit about why it is a mistake rather
than merely inelegant.

A per-application schema means a per-application reviewer interface, because the
interface renders whatever the schema declares. A per-application interface means
a per-application jury, because a reviewer trained on posts cannot be handed a
marketplace listing. A per-application jury means the random draw is drawn from a
smaller pool, which is the one resource the whole product depends on having enough
of. The schema decision is therefore the sortition decision wearing different
clothes: **the pool can only be shared if the material is comparable.**

The second force is the opposite one. An application cannot be asked to
mis-describe its own objects to fit a social-media vocabulary, or the context a
jury needs will be lost — and §9.1 gives a reviewer `insufficient_context` as a
first-class outcome precisely because deciding on incomplete material is the
failure this product cannot afford.

## Decision

**One envelope contract for every application, in which the application's own
vocabulary appears as data and never as structure.**

The envelope is resources, relations, pseudonymous principals, allegations, a
policy reference and privacy terms
(`packages/contracts/src/case-envelope.ts`). What the material is *called* in the
application that sent it lives in `subject.type` — a namespaced label such as
`social.post`, `commerce.listing` or `custom.<organization>.<object_type>` — which
is a string, not a branch. Nothing in the contract module knows what a post is.

Three properties make that survivable.

### 1. The resource union is closed, and every object is strict

`packages/contracts/src/resources.ts` is a discriminated union on `type` with
twelve variants (`text`, `image`, `video`, `audio`, `document`, `link`,
`profile`, `conversation`, `listing`, `location`, `metadata`, `custom`), each
declaring exactly which fields it may carry. There is no free-form branch, so
there is nowhere to put a rendering instruction — which is §5.7's "applications
provide data and relations, never code for the reviewer's interface", enforced by
the shape of the type rather than by a sanitiser somebody has to remember to call.

Strictness runs one way on purpose. Inbound, an unknown key is rejected loudly: a
field silently dropped is context an application believes it sent and a jury never
sees, and a field silently kept is a rendering input nobody reviewed. Outbound,
§10.11's "unknown fields must not break clients" applies, so decision and webhook
payloads are loose (`z.looseObject`). §10.11 makes exactly this exception —
"except where the schema forbids them for safety".

There is one outbound payload that is nonetheless strict, and it is the
reputation event; see ADR 0003.

### 2. An application's own vocabulary is registered, bounded and unresolvable

§5.7 lets a tenant register a JSON Schema for its own fields. Two limits make
that safe rather than an escape hatch:

- A custom payload is bounded JSON — fixed depth, bounded arrays, bounded
  strings, scalar-only metadata — and object keys must match
  `ObjectKeySchema`, which forbids `__proto__`, `constructor` and `prototype`
  (`packages/contracts/src/primitives.ts`). The depth bound is unrolled rather
  than recursive so it is part of the exported JSON Schema rather than a runtime
  afterthought.
- The same key grammar forbids `$`-prefixed keys, which removes `$ref`,
  `$dynamicRef`, `$recursiveRef` and `$id` in one move. §5.7's "no remote
  components" is not only a rendering rule: **a remote `$ref` in a
  tenant-supplied schema is an SSRF with the tenant holding the pen.** The cost
  is that recursive tenant schemas are not supported, which flat custom-field
  schemas do not need.

What is deliberately *not* there is any lexical filter on text. The material
under review is hostile by definition — a harassment report quotes the
harassment, a phishing report quotes the link. A blocklist would reject the
evidence and protect nothing, because the contract has no field whose value is
ever interpreted as markup, a template, a component or a URL to be fetched.
§5.7's boundary is structural, not lexical.

### 3. References resolve inside the envelope

§5.5 requires the backend to check that every referenced id exists. That check
lives in the schema (`CaseEnvelopeSchema.superRefine`), because it is a property
of the document and nothing downstream can restate it as reliably. It is extended
past `relations` to every in-envelope reference — `subject.primaryResourceId`,
`allegation.resourceIds`, `authorPrincipalRef`, conversation members, listing
media and seller, profile avatar — since a dangling id is the same defect wherever
it appears. The primary resource must additionally carry `role: 'subject'`.

## Why resources and schemas are versioned

Versioning here is not future-proofing. It is what stops a decision from being
re-interpreted under rules it was not made under, and what stops two
representations of the same material from being treated as one.

**The envelope carries `schemaVersion` (`crowdsource.case.v1`) and it
participates in the content hash.** That is a real trade-off, stated where it is
made (`packages/backend/src/modules/evidence/contentSnapshot.ts`): the day a
`crowdsource.case.v2` envelope describes the same post as a v1 one, the two get
separate cases instead of merging. That is the safe direction. A representation is
only comparable within the schema version that defines what its fields mean, and
merging across versions would hand a jury material a v2 reader would read
differently.

**A registered custom resource schema carries its own `version`**
(`ResourceSchemaRegistrationSchema` in `packages/contracts/src/resources.ts`), so
a tenant that changes what one of its fields means does not change the meaning of
cases already decided.

**Every decision is stamped with three policy versions** — taxonomy, application
policy set, and Oxy conduct — and never fewer
(`DecisionPolicyVersionsSchema` in `packages/contracts/src/policies.ts`). §6.4's
"a policy update never silently rewrites historical decisions" is unenforceable
without a version on every decision from the first one. `OXY_CONDUCT_POLICY_VERSION`
is pinned in the package that both the decision DTO and the reputation event
import, so those two cannot drift into describing one decision under two conduct
policies. It is a label, not a promise that the bridge which will evaluate it
exists — it does not (ADR 0003).

**An edit is a new version of the material, not an amendment.** Changing a
resource changes its `sha256` and therefore the canonical content hash, which
changes the dedup key and opens a new case. The `previous_version` relation is how
an envelope says which representation it superseded.

**A decision is versioned by revision, never edited.** Supersession is a new row
(`packages/backend/src/modules/decision/revision.service.ts`), and
`packages/backend/src/__tests__/decisionImmutability.test.ts` scans the source
tree to assert that only the publishing module writes the collection at all, that
the one sanctioned write moves `status` and names no field §9.9 protects, and —
because a check that cannot fail is worthless — that a mutation of either property
would be caught by name.

## The constraint that shapes everything the client composes

Ingress fingerprints the whole `{ externalReportId, envelope }` to detect
§10.5's payload conflict. Therefore:

> **Nothing the client composes may vary between two deliveries of the same
> report.**

An invented timestamp, a random id or an unsorted list turns a legitimate outbox
retry into a permanent `409` — silently, days later, surfacing as moderation work
stuck in a queue rather than as an error anybody sees. This is not a style rule
about the SDK; it is a schema constraint, and the schema is shaped by it:

- Resource ids are positional, not random.
- Principal refs are derived from the identity, not minted per report.
- `source.submittedAt` has **no default**. A default would be "now", and "now"
  differs between two deliveries of one report.
- `DEFAULT_POLICY` in `packages/sdk/src/defaults.ts` names an immutable published
  version, never "whatever is current", and must equal
  `BASELINE_POLICY_SET_ID`/`BASELINE_POLICY_VERSION` in the backend's
  `policyBaseline.ts`. `packages/sdk/src/__tests__/defaults.test.ts` reads that
  file and asserts it. A resolved-at-ingress "latest" would move the policy under
  an application that changed nothing, and would split §7.3's dedup key, giving
  one post two cases.

The same reasoning drives the canonical scalar forms in
`packages/contracts/src/primitives.ts`. A digest is always `sha256:<64 lowercase
hex>` and the bare form is rejected rather than normalised — normalising would
mean the digest CrowdSource stores is not the digest the application sent.
Timestamps are millisecond-precision UTC with offsets rejected, because
`18:00+02:00` and `16:00Z` are the same instant and hash differently. And `:` is
excluded from every identifier, because §7.3 joins the dedup key components with
it and an identifier containing `:` makes that join ambiguous — two distinct
tuples could flatten to one string and merge two unrelated cases.

## What the envelope deliberately does not carry

| Not carried | Why |
| --- | --- |
| The reporter's identity | A reporter is a pseudonymous `principalRef` at most. §9.1 keeps the reporter unknown to the jury, and §13.5 requires a pseudonymous principal wherever one suffices. |
| A verdict, or anything shaped like one | `sensitivityHint` and `urgency.hint` are inputs to triage (§7.4), never to a finding. `allegations` are what one reporter *claims*; §6.2 has the allegation and the finding diverging as the normal case. |
| Any reputation figure | Not for the author, the reporter or anybody else. There is no field for one. |
| The number of reports | A count is a popularity signal, and §9.1 forbids showing it to a jury. Merging is the case's business, not the envelope's. |
| Application brand, name or icon | A reviewer who knows which product a case came from is a reviewer who knows its brand. |
| Markup, templates, components or remote URLs to render | See §1 and §2 above: there is no field for any of them, which is what makes the absence of a lexical filter safe. |
| Executable anything | §5.2's rule, expressed as a closed union with no free-form branch. |
| A tenant identifier the caller controls | `applicationId` is on the envelope **only so a mismatch can be detected**. `packages/backend/src/modules/ingestion/envelopeValidation.ts:101` compares it to the credential-derived id and records an `application_mismatch` refusal on disagreement. The credential is the only source (ADR 0001 §5). |

Two of these deserve a note about the *nuance*, because the naive reading is
wrong in both cases.

**The reporter's free text is accepted and never shown.** `AllegationSchema` has
an optional `details` field, which the reporter may fill. It is excluded from the
content snapshot (`OMITTED_FROM_CONTENT_HASH` in `contentSnapshot.ts`) and the
assignment package sends only `stored.allegationCodes`
(`packages/backend/src/modules/sortition/assignments.routes.ts`). So reporter
prose reaches the database and does not reach a reviewer's screen. That is a
current behaviour of the projection, not a schema guarantee, and it is recorded in
the threat model as such.

**The reporter is excluded from the hash for correctness, not only privacy.** Two
people reporting the same post send envelopes whose only structural difference is
which reporter they name. Including that would give the two envelopes different
content hashes, two cases and two consequences for one incident — the precise
failure the "one penalty per incident" invariant exists to prevent.

## Consequences

1. Adding a resource type is an edit to one union in one package, and every
   application gets it. Adding an application requires no schema change at all.
2. The reviewer interface can be written once, against a closed union, and is
   never handed a shape it has no renderer for without knowing that is what
   happened. Where a renderer is genuinely missing — video, audio and file
   resources today — the reviewer is told plainly and
   `insufficient_context`/recusal stay open
   (`packages/reviewer/components/review/ResourceView.tsx`).
3. A tenant that needs a field CrowdSource has never heard of registers a schema
   and gets it rendered by CrowdSource's own components, with no path from its
   payload to the reviewer's runtime.
4. The strictness is load-bearing on ingress and would be a regression to relax.
   A future "accept unknown fields and ignore them" would silently discard
   context, and the symptom is a decision made on incomplete material, which no
   test can see.

## Gaps recorded by this ADR

- **The reviewer app and the reviewer API do not currently agree on any payload.**
  This is the one place the "one contract" property is not actually being held,
  and it is worth listing precisely:
  - `projectAssignmentPackage`
    (`packages/reviewer/lib/reviewer-api/redaction.ts`) requires `language`,
    `category`, `sensitivity`, a singular `allegation` object and
    `policy.policyVersion`. `reviewPackage`
    (`packages/backend/src/modules/sortition/assignments.routes.ts`) sends none of
    those; it emits `allegations` (plural), `policy.version` and a `presentation`
    block. It throws at `language`.
  - Resources differ in shape: the backend forwards contract resources (`type`,
    `role`, `data`) and the app reads `kind`/`text`/`fileId`.
  - `projectReviewerProfile` requires `preferences`, `consent` and `exposure`
    objects; `profileView`
    (`packages/backend/src/modules/reviewer/reviewer.routes.ts`) sends flat
    fields. It throws at `preferences`.
  - The reviewer-state vocabularies disagree outright. The backend's
    `REVIEWER_STATES` are `community`, `trusted`, `specialist`, `appeals`
    (`packages/backend/src/modules/reviewer/reviewerState.ts`); the app's enum
    expects `community_reviewer`, `trusted_reviewer`, `category_specialist`,
    `appeals_reviewer`.
  - Two endpoints the app calls do not exist: `POST /v1/reviewer/onboarding` and
    `GET /v1/reviewer/reviews` (`packages/reviewer/lib/reviewer-api/client.ts`
    lists both in `REVIEWER_ENDPOINTS`).

  No test in the repository feeds a backend payload to an app projection, which is
  how the two drifted this far without anything failing.
- §5.7's second validation pass does not exist. `CustomResourceSchema` says the
  payload is "validated twice: structurally here, then against the registered
  JSON Schema at ingress", and there is no schema registry, no registration route
  and no ingress check against a registered schema. The structural pass is real;
  the semantic one is not.
- ~~`POST /v1/uploads` is called by the published SDK and served by nothing.~~
  **Closed by `9f577343`.** `AssetRefSchema` now requires a bare `fileId`
  (`OxyFileIdSchema`) and the SDK's upload module is deleted, so an asset is a
  reference into the ecosystem media chokepoint rather than something CrowdSource
  ingests. `url` survives as an optional record of where the material was found —
  "recorded, never fetched", which keeps §7.2.7's scheme rule from being mistaken
  for an SSRF control. Note this also removed the earlier `superRefine` requiring
  exactly one of `uploadId`/`url`: the two are no longer alternatives, since
  `fileId` is now the only source of bytes. See ADR 0001 §3.
