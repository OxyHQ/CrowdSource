# Threat model

- **Status**: current as of 2026-07-30, against `origin/main` = `978d31ac`
- **Revises**: PLAN §13.1, which was written before any of this existed and
  assumes PostgreSQL Row Level Security, an S3 evidence bucket and three
  environments. See ADR 0001 for why none of those is what runs.

## How to read this

Every control below names the file that implements it and says whether a test
proves it. Where a control the plan assumed is **absent**, the row says so
plainly. A documented protection that does not exist is worse than an acknowledged
gap, because the next person stops looking.

Three structural facts govern the whole document and are repeated in the rows they
affect:

- **Tenant isolation is a property of this codebase and of nothing underneath
  it.** There is no Row Level Security. A query that reaches around
  `packages/backend/src/db/collections.ts` is isolated by nothing, and the only
  thing that would notice is a source-scanning test at build time (ADR 0001 §5).
- **Several surfaces named in the plan do not exist yet**: the appeal object, the
  Trust & Safety console, the developer console, the reputation bridge, and
  application trust standing. A threat against a
  surface that does not exist is not mitigated — it is unreached, and it becomes
  live the day the surface lands. Those rows are marked **unreached**.
- **Two tenancy changes are in flight and are not in the tree**: an
  `organization_members` mapping, which adds an Oxy session plus a membership check
  as a second source of tenant proof through the one existing constructor; and a
  privileged cross-tenant read for Trust & Safety, built as named queries with the
  projection baked in. Rows §2 and §7 are written so they do not go false when
  those land, and neither is described here as a guard that exists. ADR 0001 §5
  *In flight* holds the detail.

---

## 1. A reviewer reaching a case they were not assigned

**The attack.** A signed-in reviewer — a real, eligible one — tries to open a case
they were not drawn for: by guessing a case id, by replaying an assignment id
they saw, by asking for a queue, or by targeting a specific piece of content
somebody asked them to go and judge.

**What stops it today.**

1. **There is no case id in the reviewer API at all.** Every reviewer route is
   addressed by *assignment*
   (`packages/backend/src/modules/sortition/assignments.routes.ts`), and
   `POST /v1/reviewer/assignments/next` takes no parameters — not a category, not
   a filter, not an id. "Nobody chooses the case they review" is a fact about the
   routing table rather than a rule somebody enforces. There is nothing to ask.
2. **Two independent facts authorise an assignment**
   (`packages/backend/src/modules/sortition/assignment.service.ts`,
   `authorizeAssignment`). The Oxy session says *who* is asking; the
   `x-assignment-token` header says *which* case they hold. Neither substitutes
   for the other: a valid session with somebody else's assignment id is refused
   because the row names another reviewer, and a leaked assignment id is useless
   without its token.
3. **The token rotates on every opening**, so "reuse an old token" has an
   unambiguous answer — the old one is dead, not merely stale — and only its hash
   is stored.
4. **Every refusal is the same `404` with the same message**, whether the
   assignment does not exist, belongs to somebody else, expired, or was already
   submitted. A `403` would confirm the assignment exists, which tells the asker a
   case exists and that somebody was drawn for it.
5. A nonexistent id still spends a token comparison, so it is not measurably
   cheaper to reject than a real id with a wrong token.

**Tested.** Yes, directly.
`packages/backend/src/__tests__/sortitionPanel.integration.test.ts` §"a user who
was not selected cannot open or vote" asserts: cannot reach the case by id (no
reviewer route accepts one), cannot open somebody else's assignment even knowing
its id, cannot vote on it, cannot recuse from it, gets nothing from `next`, and is
refused with no session at all. The same suite asserts the case is refused without
the assignment token and that a token from a previous opening no longer works.
`reviewerFailureModes.integration.test.ts` covers a malformed id (404 without
querying) and a case that has disappeared behind a live assignment.

**Residual risk.** A reviewer who *was* legitimately drawn still sees the material
— that is the product. The exposure limits in
`packages/backend/src/modules/reviewer/eligibility.ts`
(`SENSITIVE_EXPOSURE_WINDOW_HOURS`, `SENSITIVE_EXPOSURE_MAX`,
`MAX_OPEN_ASSIGNMENTS`) bound how much one person can be shown, and rest applies
only to the sensitive route so that looking after yourself does not cost you your
place in the pool.

## 2. An application reading another tenant's data

**The attack.** A tenant with a valid service credential tries to read a case,
report or decision belonging to another application — by passing another
`applicationId` in a body, by guessing a `caseId`, or by exploiting a route that
forgot its filter.

**What stops it today.**

1. `applicationId` comes from the credential and from nowhere else
   (`packages/backend/src/modules/tenancy/credential.service.ts`). The
   authenticated caller is held in a module-private `WeakMap` keyed by the
   request, **not assigned onto the request object** — a property on `Request` is
   writable by any later middleware and readable by anything that guesses the
   name.
2. `createTenantContext` is the **only constructor** for a `TenantContext`
   (`packages/backend/src/db/tenantScope.ts`), so there is exactly one place to
   audit when asking "can a caller influence this?". Today it is called from
   exactly one place — where the service credential is resolved — because nothing
   in the tree maps an Oxy user to an organization. **Those are two separate
   facts:** one constructor is the rule, and one caller is the current state. An
   `organization_members` mapping is in flight that adds an Oxy session plus a
   membership check as a second source of proof, still through the one
   constructor. See ADR 0001 §5 *In flight*.
3. Supplying a tenant key yourself **throws** rather than being silently
   corrected. The belief that a caller picks the tenant is the bug and has to
   surface in a test.
4. Tenant-owned collections have no unfiltered method to call
   (`packages/backend/src/db/collections.ts`): the Mongoose model is a `#private`
   field, and updates take a restricted operator spec rather than a raw
   `UpdateQuery`, because a raw one accepts `$set: { applicationId }` and would
   move a document between tenants.
5. A cross-tenant read answers `404`, not `403`, and **writes no audit row in
   either tenant's trail**. Both are real, but they are two different kinds of
   claim and the difference matters if you are deciding what you may rely on:
   - The `404` on a foreign case id is a **consequence of the tenant filter**, not
     a decision taken at the route: `findCaseView` is scoped, returns null, and
     the handler throws `not_found`. It is asserted
     (`caseAccess.integration.test.ts`, with a control proving the owner sees the
     same id), so it is a tested property — but nothing chose `404` over `403`
     here. Contrast the reviewer surface, where `404`-not-`403` **is** a designed
     control with its reasoning in source
     (`packages/backend/src/modules/sortition/assignments.routes.ts`: a `403`
     would confirm the assignment exists).
   - The missing audit row **is** deliberate, with the reasoning stated in source
     at `packages/backend/src/modules/cases/cases.routes.ts:16-20` and repeated in
     the test that asserts it. The stated reason is trail pollution: a `404` is
     indistinguishable from "belongs to another tenant" by design, so auditing it
     would let one tenant fill another's trail — or its own — with rows generated
     purely by probing. What is worth recording is a successful read. (An earlier
     draft of this document gave a different reason — that a row in the victim's
     trail would itself be a cross-tenant signal. That is not the reason the code
     gives, and it is not recorded here as one.)
6. Public ids are ULID/UUID (`packages/backend/src/utils/identifiers.ts`), never
   sequential, so enumeration has nothing to walk.
7. An envelope that names a different application than its credential is refused
   and the refusal recorded as `application_mismatch`
   (`packages/backend/src/modules/ingestion/envelopeValidation.ts:101`,
   `reports.routes.ts:88`).

**Tested.** Yes, heavily.
`packages/backend/src/__tests__/tenantIsolation.integration.test.ts` asserts a
`404` across organizations over HTTP, a `404` between two applications of the
*same* organization, a control case proving the document is reachable without the
filter, refusal of a request body that names a tenant at all, and that the
idempotency indexes are per application so two tenants may reuse one
`externalReportId`. `tenantCollectionWrites.integration.test.ts` asserts an update
cannot reach another application's document and that an upsert never finds one.
`caseAccess.integration.test.ts` asserts the `404` for a foreign case id and that
no audit row is written for the miss.
`collectionBoundary.test.ts` scans the source tree for driver access outside the
access layer, pins the exact set of unscoped collections with their stated
reasons, and mutation-tests itself. **It does not pin `DRIVER_ACCESS_ALLOWED`** —
it asserts only that the paths already listed are not flagged, so adding a
directory to that allowlist passes the whole suite. That asymmetry becomes
load-bearing in §7.

**Residual risk — the largest in this document.** All of the above is code and
build-time scanning. There is no database-level guarantee. Any authorization
defect here must be treated as a critical incident, because nothing else would
have caught it. `packages/backend/src/config/databaseIdentity.ts` guards the
adjacent failure — writing into *another Oxy product's* database — with a source
constant, a pre-release script, a mutation test of that script, and a runtime
assertion.

## 3. Author-supplied text as an injection vector into a reviewer's screen

**The attack.** The author of reported material — or an appellant writing an
appeal — composes text designed to act rather than to be read: markup, a script
fragment, a `javascript:` URL, a prompt-injection instruction aimed at whatever
reads the screen next, or a payload aimed at the reviewer app's runtime.

**What stops it today.**

1. **There is no field in the contract whose value is ever interpreted.**
   `packages/contracts/src/resources.ts` is a closed discriminated union with no
   free-form branch; text carries `formatting: 'plain' | 'markdown_subset'` and
   never HTML. There is no template, no component reference, and no remote URL to
   be fetched and rendered.
2. **Custom payloads cannot reference anything.** `$`-prefixed keys are forbidden,
   which removes `$ref`, `$dynamicRef`, `$recursiveRef` and `$id` in one move — a
   remote `$ref` in a tenant-registered schema would be an SSRF with the tenant
   holding the pen (`packages/contracts/src/primitives.ts`,
   `ResourceSchemaRegistrationSchema`).
3. **There is deliberately no lexical filter on text**, and that is correct: the
   material under review is hostile by definition, and a blocklist would reject
   the evidence while protecting nothing. The boundary is structural.
4. **The renderer has no HTML sink.** `packages/reviewer/components/review/ResourceView.tsx`
   renders text through React Native `<Text>`. A scan of all 285 `.ts`/`.tsx`
   files across every package finds no `dangerouslySetInnerHTML`, no
   `innerHTML`/`outerHTML`, no `WebView` component, no `eval(` and no
   `new Function(`. (The `WebViewStyle` type alias in
   `packages/reviewer/types/webStyles.ts` is a react-native-web style type and not
   the `WebView` component — a scan for this must not confuse the two, in either
   direction.)
5. **Links are displayed, never opened.** Following a reported URL from the
   reviewer's device would hand the reported site the reviewer's address and load
   whatever it wants to serve.
6. **Reporter prose does not reach the screen.** `AllegationSchema.details` is
   accepted, excluded from the content snapshot
   (`OMITTED_FROM_CONTENT_HASH` in
   `packages/backend/src/modules/evidence/contentSnapshot.ts`), and the assignment
   package sends only `stored.allegationCodes`.

**Tested.** Partly. `packages/contracts/src/__tests__/resources.test.ts` and
`case-envelope.test.ts` cover the structural rules (strictness, the closed union,
the forbidden key grammar, media-type agreement). **Nothing asserts the absence of
an HTML sink in the reviewer app.** That is a cheap mechanical check and is
recorded as a gap below.

**Gap — appeals do not exist, so appeal text is unreached.** There is no appeal
object with a requester, a reason or structured additional context.
`packages/backend/src/modules/decision/revision.service.ts` implements only the
supersession *mechanism* and says so: an appeal surface belongs to §15.9.
`appeal.created` and `appeal.decided` are absent from the webhook fan-out for the
same reason (`packages/backend/src/modules/webhooks/fanout.ts`). When that surface
lands, appellant free text will be the **first author-composed prose intended for
a reviewer's eyes**, and it inherits none of the reporter-prose protection above —
`allegationCodes` are codes, and appeal reasoning is not. It must be projected
onto a typed field and rendered through the same no-sink path, and this row should
be revisited in the same change.

**Residual risk.** A reviewer can still be *socially* manipulated by text they are
required to read. `insufficient_context`, recusal and the wellbeing exit are the
answers the product has, and none of them is a technical control.

## 4. A colluding jury

**The attack.** Several reviewers coordinate to reach a predetermined outcome —
either a standing clique that keeps landing on the same panels, or sock puppets
run by one person, or a party to the case sitting on its own jury.

**What stops it today.**

1. **Nobody chooses their case** (see §1). Coordination requires being seated
   together, and seating is a server-side draw.
2. **Six exclusion rules remove entangled candidates**
   (`packages/backend/src/modules/sortition/exclusions.ts`): `subject_principal`,
   `reporter`, `prior_juror`, `declared_relation`, `application_conflict`,
   `party_risk_cluster`. Ordered so the recorded reason is the strongest one.
3. **The reporter check is drift-proof by construction.** A candidate's
   fingerprint is computed with the *same exported function* the case wrote its
   fingerprints with. A second copy of the format would drift invisibly, and the
   failure — a reporter sitting on the jury of their own report — would ship with
   a green suite either way.
4. **The affinity throttle** caps how many panels two reviewers may have shared
   before they stop counting as two independent judgements (`MAX_CO_SERVICE = 3`),
   applied within the sampled set
   (`packages/backend/src/modules/sortition/weightedSampling.ts`,
   `sortition.service.ts`), and counters are incremented for every pair on the
   finished panel including incumbents.
5. **Risk clusters are capped per panel**, and an incumbent's cluster counts
   against the cap.
6. **A recusal is free and is recorded.** A `conflict_of_interest` recusal
   *helps* the reviewer: the relationship is stored so they are not drawn for the
   same people again. Silently re-drawing them would be a penalty in everything
   but name.
7. **The draw is reproducible and audited.** Seed, candidate snapshot and rules
   version are persisted, so a suspicious panel can be replayed.
8. **Collusion cannot be amplified by weight.** One qualified person, one vote —
   see ADR 0003.

**Tested.** Yes, and the tests are mutation-tested.
`packages/backend/src/__tests__/sortitionExclusions.test.ts` breaks each rule,
asserts the test fails and names what it caught, asserts every declared reason is
covered so a new one cannot be added untested, and includes a test that
demonstrates a *drifted* fingerprint format would MISS — which is why there is one
helper. `sortitionRefusals.test.ts` covers the 3→5→7 escalation ladder, slot
requirements rejecting as well as accepting, the reliability postcondition, and an
incumbent's risk cluster counting against the cap.
`sortitionPanel.integration.test.ts` asserts a replayed draw reproduces the same
panel and that two draws of one case never share a seed.

**Residual risk and gaps.**

- **Sophisticated collusion is never eliminated.** That is the plan's own
  assessment and it stands.
- **`riskClusterId` is never written.** It is declared on the profile, indexed,
  read by the draw and honoured by the cap — and no code path assigns it. Every
  cluster is `null` today, so the cluster exclusion and the per-panel cap
  currently match nothing. The mechanism is real and the *detection* that would
  populate it is absent, by design: `personhood.ts` states that detecting sock
  puppets, shared devices and coordinated clusters is not its job.
  `suspectedSockPuppet` is likewise read and never set.
- **Gold cases do not reach the live queue.** §9.7 wants gold items
  indistinguishable from real material as the main calibration signal;
  `packages/backend/src/modules/reviewer/calibration.ts` states plainly that
  injecting them into the live queue is not implemented. So reliability moves only
  at calibration, and the strongest ongoing anti-collusion signal is not being
  collected.
- **There is no `review_abuse_confirmed` path.** §11.12 names collusion, leaking,
  random answers and multi-account use as things that may produce it; nothing
  produces it.

## 5. A console leaking a juror's identity

**The attack.** An operator surface, a developer console, or a tenant-facing API
returns who judged a case — to the application, to the parties, or to a wider
audience than "one specific Oxy operator with a reason".

**What stops it today.**

1. **No console exists.** `packages/console` is not scaffolded, and
   `crowdsource:trust-safety:operate` is in `PRIVILEGED_SCOPES`
   (`packages/backend/src/modules/tenancy/scopes.ts`) and therefore unreachable
   through application credential issuance.
2. **`agreeingReviewerIds` never leaves the database.** It is on the decision row
   for the appeal path — §9.8 forbids any member of the original jury from sitting
   on the appeal panel — and `decisionView`
   (`packages/backend/src/modules/decision/decision.service.ts`) drops it. That
   projection existing *at all*, rather than the document being serialised
   directly, is the reason.
3. **No reviewer field is tenant-reachable.** The reviewer profile carries no
   tenant keys and no case data, and the application API has no reviewer endpoint
   (`packages/backend/src/modules/reviewer/reviewer.collection.ts`).
4. **`reviewerId` is separate from `oxyUserId`**, and a reviewer's own profile
   view withholds `oxyUserId`, `samplingKey`, `riskClusterId` and
   `suspectedSockPuppet` — publishing the sampling key would let somebody reason
   about when they are likely to be considered, and telling somebody they are
   flagged tells them to change what they are doing
   (`packages/backend/src/modules/reviewer/reviewer.routes.ts`, `profileView`).
5. **The reviewer app enforces §9.1 by projection, not by layout.**
   `packages/reviewer/lib/reviewer-api/redaction.ts` builds every object field by
   field — an allowlist, so `reportCount`, `jurors` or `authorReputation` cannot
   survive because nothing copies them — and a second pass
   (`scanForForbiddenFields`) walks the raw payload and reports the *paths* of
   forbidden fields as an alarm. It reports paths only, never values, because the
   values are exactly the material that must not reach logs.
6. **Logs carry neither identities nor content.** The backend logger
   (`packages/backend/src/utils/logger.ts`) configures no body capture and redacts
   `authorization`/`cookie`; outbox failures store the error *message* only,
   because a stack or driver error routinely quotes the document it choked on. The
   reviewer app's logger sanitiser
   (`packages/reviewer/lib/logger/sanitize.ts`) redacts keys matching
   id/uri/url/ip, email/username/handle, credential-shaped keys and
   content-shaped keys (`body`, `query`, `params`, `content`, `text`), and scrubs
   URLs, emails, IPs, UUIDs, ObjectIds, bearer tokens and handles out of message
   strings.
7. **Stored webhook response bodies are redacted.**
   `packages/backend/src/modules/webhooks/redaction.ts` masks anything shaped like
   a credential or an identity, keeps a 512-byte prefix, and that field is never
   logged at any level.

**Tested.** Yes for the parts that exist.
`consensusDecision.integration.test.ts` asserts the decision returned by the API
has `agreeingReviewerIds` undefined while the stored row has three, and that a
recused reviewer is not among them. `sortitionPanel.integration.test.ts` asserts
the assignment package "withholds report counts, other jurors and the
application". The app's `redaction.test.ts` covers the projection and the
forbidden-field scan; `logger/__tests__/sanitize.test.ts` covers the sanitiser.

**Gaps.**

- **This threat is largely unreached.** The console is the surface that would leak,
  and it does not exist. Every control above is a precondition, not a mitigation
  of the console itself. When the console lands it needs RBAC, just-in-time access,
  an audit reason on every juror-adjacent read, and dual review for exports — none
  of which exists. §7 covers the specific cross-tenant read now being built; this
  row is about juror identity in particular, and they overlap at a point sharper
  than it first looks.
- **The juror collections are already cross-tenant readable, by construction.**
  `Assignment`, `Review`, `ReviewerProfile`, `SortitionDraw`, `ReviewerAffinity` and
  `ReviewerRelation` are all declared through `defineUnscopedCollection`
  (pinned in `collectionBoundary.test.ts`), for a legitimate reason: a reviewer
  belongs to no tenant, and the caller reading them presents an Oxy session that
  carries no tenant to scope by. Rows are still stamped with the tenant of their
  case, but **nothing enforces that stamp on read.** So the named-query control of
  §7 protects `cases` and `decisions`, which are tenant collections — and a
  privileged module wanting juror identity across every application does not need a
  new primitive at all. It can read `Review` unfiltered through the ordinary
  wrapper today. What prevents that right now is only that no module does it and no
  route exposes it: the weakest form of protection in this document, and the one
  that becomes load-bearing the moment a privileged module exists.
- **The audit trail is not yet an operator trail.** `AUDIT_ACTIONS`
  (`packages/backend/src/modules/audit/audit.collection.ts`) holds six actions,
  all tenant-side reads and ingress outcomes. There is no reviewer-side audit, no
  export audit, no step-up authentication and no dual-review requirement. §13.2's
  "irreversible or export actions require step-up authentication and an audit
  reason" is unimplemented.
- **The app's projection has never met the real backend payload** — see ADR 0002's
  gaps. It is a genuine allowlist and it is written against a shape the server does
  not send, so it currently throws rather than filters. The blindness property is
  not weakened by that (nothing gets through a throw either), but the guard is
  unexercised against the thing it guards.

## 6. The reputation bridge driven directly by an application

**The attack.** An application moves an Oxy Trust figure itself — by calling a
reputation route with its service credential, by minting itself the privileged
scope, by asserting an arbitrary Oxy user id, or by emitting a decision event of
its own.

**What stops it today.**

1. **`reputation:moderation:apply` and `crowdsource:decisions:emit` are
   privileged scopes** and `issueApplicationCredential` **refuses** them rather
   than filtering them out — a filter would let a caller believe it had been
   granted something (`packages/backend/src/modules/tenancy/provisioning.service.ts`,
   `scopes.ts`). An unknown scope is refused too, rather than dropped.
2. **The event is a statement, not an instruction.**
   `packages/contracts/src/reputation-events.ts` names no points, tier, strike or
   standing; Oxy Trust's own consequence engine decides the effect. Three of
   §11.7's validations are structural: `bindingProofId` required, finding scope
   restricted to `oxy_network`/`identity_integrity` so `application_local` cannot
   appear at all, and the status enum holding only `provisional` and `final`.
3. **"No binding proof, no Oxy Trust effect" is enforced at the envelope too.**
   `PrincipalBindingSchema` requires `bindingProofId` for `oxy_user` and only for
   `oxy_user` (`packages/contracts/src/case-envelope.ts`), so an Oxy identity
   asserted without proof cannot be expressed — while the four non-Oxy principal
   types, which have no Oxy identity to move, are not locked out.
4. **A finding carries no `resourceIds` and no free text** in the event, so
   nothing about the reviewed material can reach a reputation ledger or a signed
   attestation.
5. **A service credential cannot reach a reputation route at Oxy's end either**:
   every Oxy reputation route requires a `sessionId` and answers `401` to a
   service credential.

**Tested.** Yes.
`packages/backend/src/__tests__/serviceCredential.integration.test.ts` asserts the
refusal of a privileged scope, the refusal of an unknown scope, and `401`/`403`
behaviour for missing credential and missing scope.
`packages/contracts/src/__tests__/reputation-events.test.ts` asserts that
`points`, `standing`, `strike`, `activeRisk` and `tier` are all rejected by strict
parsing.

**Gap — the bridge does not exist.** `packages/backend/src/app.ts` states it:
"The reputation bridge is not written." No module emits the event and no route
accepts it, so this row is currently a set of preconditions rather than a
mitigation. The five stateful validations of §11.7 — who signed it, whether the
event id was seen, whether the incident already produced an equivalent effect,
whether the conduct policy version covers the category — belong to the bridge and
do not exist. Neither does the
`incidentId + principalId + effectType + decisionRevision` index that makes "one
penalty per incident" true at the database. And the readiness blockers in ADR 0003
gate switching it on regardless.

## 7. Trust & Safety staff — or a compromised staff session — reading case content across tenants

**The attack.** An Oxy operator with Trust & Safety access, or an attacker holding
a stolen staff session, reads reported material belonging to tenants they have no
business seeing: browsing cases across every application, pulling a case document
whole, or shaping a cross-tenant query to return the fields §11 forbids — reporter
identity, juror identity, individual votes, sensitive material.

This row is new. §13.1 has an "insider abuse" row and it is about privilege in
general; this one is about the specific surface being built now, and it deserves
its own row because the control that will stop it is a very particular one and
easy to build in the wrong place.

**What stops it today** — "today" meaning `origin/main` at `6457cf63`, checked, not
the working tree of any agent. Nothing purpose-built, and nothing needs to be,
because the surface does not exist there:

- There is no Trust & Safety console and no `packages/console` in the tree.
- `crowdsource:trust-safety:operate` is in `PRIVILEGED_SCOPES`
  (`packages/backend/src/modules/tenancy/scopes.ts`) and
  `issueApplicationCredential` refuses to grant a privileged scope, so it cannot
  be reached through credential issuance
  (`packages/backend/src/modules/tenancy/provisioning.service.ts`).
- **`cases`, `reports`, `reviews` and `decisions` expose no unscoped read at all.**
  `TenantCollection` has no method that omits the tenant filter
  (`packages/backend/src/db/collections.ts`), so there is no primitive to call. A
  scan of all 285 `.ts`/`.tsx` files finds no `findAcrossTenants`, no
  `acrossTenants` and no cross-tenant read of any name.
- `AGENTS.md` names `Incident` as the sole path for cross-tenant correlation, and
  there is **no `Incident` collection or module** — `cases.incidentId` is a field
  that is `null` on every document, asserted so in
  `caseDeduplication.integration.test.ts`.

So today this threat is **unreached**, in the precise sense used throughout this
document: not mitigated, merely not yet possible.

**What will stop it, and why the shape matters.** A privileged cross-tenant read is
written for Trust & Safety, because §4.3 and §10.4 make T&S the audience that sees
across tenants. It is **not committed anywhere** — see ADR 0001 §5 *In flight* for
the checked status — so what follows is verified against that working tree and is
not yet a guard in the tree. The shape is **specific named queries with the
projection baked in**, allowlisted to one *file* rather than a directory, plus
scalars-only aggregation for §16.4's metrics.

Three properties of it are worth stating precisely, because each is stronger than
the obvious version and the difference is what a reviewer should protect:

1. **The projection is applied in the Mongo query, not to a loaded document.**
   `ESCALATED_QUEUE_FIELDS` is a declared constant passed to
   `.select(ESCALATED_QUEUE_FIELDS.join(' '))`. A forbidden field therefore never
   enters the process. That is materially stronger than "projected before
   returning": a later `JSON.stringify` of an intermediate, a debug log, an error
   that quotes the document — none of them can leak what was never loaded.
2. **Juror data is protected by FIELDS, not by the tenant.** This is the finding
   from §5 turned into the control. No console-reachable accessor returns a
   `reviewerId`, an assignment, or a per-juror vote. The review-activity summary
   uses `distinct` on the *outcome* with a count per value rather than an
   aggregation grouping by reviewer — deliberately, because a group-by-reviewer
   pipeline is one field away from naming somebody, while a count cannot name
   anybody however it is later extended. Given that the juror collections are
   already unscoped (§5), field discipline is the *only* control available here;
   there is no tenant filter to fall back on.
3. **A staff read that cannot be audited must fail.** `staff_audit_events` is a
   separate collection from `audit_events` precisely because a staff read spans
   every tenant at once while the tenant trail is tenant-scoped — one row cannot
   honestly belong to one tenant. It records the operator, the roles held **at the
   time** (copied, not joined: the question in an investigation is what they were
   entitled to *then*, and a join answers what they are entitled to *now*), and at
   most one application id. If the audit write fails the read fails, because the
   trail is the only control §13.1 offers against a legitimate operator, and an
   unaudited privileged read is indistinguishable from an abusive one.

A general `findAcrossTenants(filter)` was rejected, and the reasoning is the guard:

> A cross-tenant read of `cases` is a **privacy** boundary as much as a tenancy
> one, because case documents carry reported material. **A filter parameter
> controls who may call, not what they may ask.** Authorising the caller and then
> letting them name the fields satisfies the tenancy control while leaving the
> privacy one to be bypassed by an argument. So the projection must be unreachable
> from the caller — inside the named query, never at the screen.

The corollary is what makes this row worth writing down before the code lands: a
projection applied in the console, in a serializer, or in a route handler is not
this control. It is the same class of mistake as enforcing §9.1's blindness by
layout instead of by projection — which the reviewer app got right
(`packages/reviewer/lib/reviewer-api/redaction.ts`) and which is worth copying
here: build the object field by field, so a field reaches a T&S screen only because
somebody edited a reviewable allowlist.

**Tested.** Nothing on `main`, because nothing exists there. In the uncommitted
worktree the three assertions this row asked for do exist, verified:
`packages/backend/src/__tests__/crossTenantReads.test.ts` (the projection, asserted
against `ESCALATED_QUEUE_FIELDS`), and `collectionBoundary.test.ts` now pins
`DRIVER_ACCESS_ALLOWED` to an exact set
(`expect(Object.keys(DRIVER_ACCESS_ALLOWED).sort()).toEqual([…])`) — with a comment
recording that it had been the one unpinned authority in the access layer. It landed
*before* the new module joined that list, which is the right order: the precedent is
now "an entry arrives with a test change", not the reverse.

None of that is a passing gate until it is committed and CI has run it.

**Residual risk.** A privileged operator will legitimately see across tenants —
that is the job. What the projection buys is that the *maximum* they can see is
decided in reviewable source rather than at call time. Everything §13.1's insider
row asks for and this repository does not have — RBAC, just-in-time access, an
audit reason on every read, dual review for exports — is still missing, and the
audit vocabulary (`AUDIT_ACTIONS`, six tenant-side actions) has no entry that could
record a T&S read.

---

## Revised §13.1 rows

The rows below are the plan's original threats, updated to what the system now is.

### Malicious reporter

**Controls that exist.** A reporter's id is never stored on a case. What is
stored is `sha256(applicationId + ':' + 'principal:' + externalPrincipalId)`
(`reporterFingerprint` in
`packages/backend/src/modules/cases/case.service.ts`), which is why the reporter
exclusion runs in the only available direction: fingerprint the candidate, then
look them up. Distinct reporters are counted from those fingerprints and weigh far
more than report volume; reports beyond the number of distinct reporters are
volume without new signal (`packages/backend/src/modules/triage/triage.ts`). A
reporter's standing may nudge queue priority by at most
`TRIAGE_WEIGHTS.REPORTER_PRIORITY_BOOST_MAX` (5 points) and is never shown to a
jury. Dedup guarantees a hundred reports become one case.

**Be precise about what the fingerprint is.** It is **domain separation, not a keyed
MAC.** Because the application id is mixed in, the same person under two tenants
produces two unrelated values, so the case collection cannot become a cross-tenant
correlation table — that property is real. But the application id is not a secret,
and neither is the tenant's own `externalPrincipalId`, so **an application can
recompute the fingerprints of its whole user table** and recover which of its users
reported what. It is non-reversible to a party that does *not* know the inputs — a
reviewer, another tenant — which is the property §9.1 needs. It is not
non-reversible to the tenant itself.

The consequence is a rule, not a nuance: **no surface returns these values to an
application at any role, not even as a distinct count.** Containment is that nothing
serves them; making the digest keyed would close it properly and is a migration
rather than an edit, since every stored fingerprint would have to be recomputed.

The misleading source comments that called this "salted" have been corrected across
the sites that carried them (verified in the uncommitted `phase9/console` worktree:
zero occurrences of "salted" remain in `case.service.ts`, `case.collection.ts` and
`exclusions.ts`, replaced by a statement of the above plus the rule). **The digest
itself is unchanged**, so this remains a live finding about the mechanism and not
only about its documentation.

**Gaps.** `platform_abuse.report_abuse` exists as a taxonomy code and nothing
else: there is no report-abuse flow, no campaign detection, and no reporter
reliability figure. `reporterPriorityBoost` is an optional input that nothing
supplies. There is **no rate limiting anywhere in the service** — `express-rate-limit`
is a dependency only because `@oxyhq/core/server` is a single barrel that requires
it eagerly, and no limiter is mounted. So §13.1's "límites" and the quota half of
"aplicación maliciosa" are both absent.

**Residual.** Unchanged from the plan: a determined reporter can still add load
and delay cases.

### Author editing or deleting evidence

**Controls that exist.** The content snapshot is immutable and written once by the
first report; every later report that merges necessarily carries the same bytes,
because matching the hash is what put it there. Each resource carries a required
`sha256` in canonical `sha256:<hex>` form, and the envelope has a canonical hash
over a normalised projection. An edit changes the hash and therefore opens a new
case rather than mutating an old one.

**Gap — the asset copy does not exist.** §13.1's control for this row is
"snapshot, hash and **copy of assets**", and §5.6 is explicit about not depending
on a URL the application controls. Inline text is snapshotted; binary evidence is
a reference — now a bare Oxy `fileId` since `9f577343` removed uploads from the
contract, so the bytes live behind the ecosystem media chokepoint and CrowdSource
never ingests them. Nothing copies an asset into
storage CrowdSource controls, and nothing verifies a fetched byte stream against
its declared `sha256`. **An author who deletes an image after reporting removes it
from the reviewer's screen**, and the hash proves only that whatever *is* served
is or is not what was declared — which nothing currently checks.

### Coordinated jurors

See §4 above.

### Malicious application

**Controls that exist.** `applicationId` from the credential only; the envelope's
copy exists solely so a mismatch can be detected; strict inbound parsing so a
field cannot be smuggled onto a reviewer's screen; bounded limits on every array
and string (`CONTRACT_LIMITS`); a 1 MB JSON body cap
(`packages/backend/src/app.ts`); no path from a tenant payload to the reviewer's
runtime; no direct reputation access.

**Gaps.** Application trust standing (§11.13) does not exist — `ApplicationDocument`
has `status: 'active' | 'suspended'` and nothing more — so `source.environment:
'sandbox'` is a label that changes no handling. There are no quotas and no rate
limits. The §5.7 semantic validation pass against a registered schema does not
exist.

**Residual.** Unchanged: an application can still submit partial or misleading
evidence. `insufficient_context` and `content_unavailable` are first-class review
outcomes for exactly that reason.

### Credential leak

**Controls that exist.** Secrets are stored as SHA-256 digests and the token is
returned exactly once
(`packages/backend/src/modules/tenancy/credential.service.ts`, and
`serviceCredential.integration.test.ts` asserts both). Comparison uses
`verifySecret` from `@oxyhq/core/server`, never `!==`, and an unknown credential
id costs the same as a wrong secret — both compare against a fixed absent-hash
constant. Every rejection is the same `401` with the same message; distinguishing
unknown id, wrong secret, revoked credential and suspended application would hand
an attacker a search procedure. Revocation and expiry are honoured in both
directions. A credential naming one organization while its application names
another is refused as corruption, not as a login failure — which stops a stale
credential from surviving an application being moved. Audit rows name the
credential, not merely the application, which is the difference between "somebody
at this tenant did it" and "the leaked key did it".

**Gaps.** No rate limiting, so nothing throttles credential grinding. No alerting.
Rotation exists for webhook secrets
(`POST /v1/webhook-endpoints/:id/rotate-secret`) and not for service credentials.

### Webhook replay

**Controls that exist.** `timestamp + "." + rawBody`, HMAC-SHA256, header
`v1=<hex>`, with a 300-second tolerance
(`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`). The signed-payload builder is shared
between sender and receiver via the published contract, so the two cannot each
decide what gets signed. The signature covers the **raw** body — a parsed and
re-serialised body is different bytes and does not verify, which is what stops a
receiver validating one document and acting on another. The timestamp is the
header value verbatim rather than re-derived from a parsed number. Comparison is
constant-time. One logical delivery is unique per
`webhookEndpointId + eventId`, and the event id **is the outbox row's id**, so
replaying the outbox produces the same pairs and the receiver dedupes on the same
string it already saw. The shipped receiver middleware claims before running the
handler and releases on failure — recording the id first makes a handler failure
permanent, recording it after lets two concurrent deliveries both run
(`packages/sdk-express/src/store.ts`).

**Tested.** `webhookSigner.test.ts` (including verification against an
independent implementation, so the signer is not checked only against itself),
`webhookTransport.test.ts` (with a test that drives a `safeFetch`-blocked
address), `webhookRetrySchedule.test.ts`, `webhookSecretCipher.test.ts`,
`webhookRedaction.test.ts`, `webhookDelivery.integration.test.ts`, and the
`sdk-express` suite including a full loop.

**Residual.** Unchanged: implementation errors on the receiver's side. The
middleware exists to remove the reasons for them.

### Cross-tenant leak

See §2 above. **The plan's control list for this row names "RLS" and that control
does not exist** (ADR 0001 §5).

### Insider abuse

The cross-tenant half of this row is now §7, which covers the surface being built.
What follows is the general privilege problem.

**Controls that exist.** Privileged scopes are not self-grantable. Audit rows are
written by `appendAuditEvent` with a closed action vocabulary and a closed refusal
vocabulary — a free-text reason is where an envelope fragment ends up.

**Gaps.** Almost everything this row needs: no RBAC, no roles, no just-in-time
access, no step-up authentication, no dual review for exports, and no audit of any
operator action (there is no operator surface to audit). The audit collection is
append-only by convention — nothing exposes an update or delete for it — but it is
an ordinary MongoDB collection, so "append-only" is a property of the code, not of
the store.

**Residual.** Privileged personnel remain a risk, and today there is nothing
between them and the data but the absence of a console.

### Dangerous content and reviewer welfare

**Controls that exist.** `privacy.allowCommunityReview: false` routes a case to a
specialist pool and is not a preference triage may override upwards
(`packages/contracts/src/case-envelope.ts`). The legal route is **refused rather
than composed** — §7.5's legal pool has no specification, and
`sortitionRefusals.test.ts` asserts the ladder "has NO specification for the legal
pool, and says so loudly" while
`reviewerFailureModes.integration.test.ts` asserts a legal case records a refusal
and opens nothing. Adult-only families gate on age. Sensitive exposure is capped in
a rolling window and rest applies only to the sensitive route. The reviewer app
does something stronger than the plan's blur: until the reviewer asks for it,
sensitive material is **not rendered at all** — content that was never mounted
cannot leak — and consent is checked before the reveal is even offered, with a
route to withdraw it (`packages/reviewer/components/review/SensitiveGate.tsx`).
Case material never touches device storage: images are loaded with
`cachePolicy="none"`, and `packages/reviewer/utils/storage.ts` is for preferences
only. Recusal costs nothing and returns `204` with no body, because a body
reporting consequences would be the first step toward it having some.

**Honest limits.** Text is `select-none` and unselectable, which §13.8 asks for
and which the code itself describes as a speed bump rather than a control. A
watermark component exists (`WatermarkedMaterial.tsx`); the backend sends no
watermark value, so nothing populates it today.

**Residual.** Human exposure cannot be reduced to zero.

---

## Complete list of gaps in this document

1. No rate limiting anywhere in the service; no quotas.
2. No evidence asset copy and no byte-level hash verification, so evidence can
   still disappear from under a reviewer.
3. ~~No evidence upload route, though the published SDK calls one.~~ **Closed by
   `9f577343`** — uploads removed from the contract and the SDK; an asset is a bare
   Oxy `fileId`. Gap 2 above is the part that survives.
4. Appeals do not exist as an object; appellant free text will be the first
   author prose aimed at a reviewer and is not yet covered.
5. `riskClusterId` and `suspectedSockPuppet` are read by the draw and written by
   nothing, so cluster exclusion and the per-panel cluster cap match nothing today.
6. Gold cases are not injected into the live queue, so reviewing reliability moves
   only at calibration.
7. No `report_abuse` or `review_abuse_confirmed` path.
8. No application trust standing, so `source.environment: 'sandbox'` changes
   nothing.
9. No §5.7 semantic validation against a registered schema; no schema registry.
10. The reputation bridge does not exist, nor the
    `incidentId + principalId + effectType + decisionRevision` index behind "one
    penalty per incident".
11. No RBAC, step-up authentication, dual review, export audit, or any
    operator-action audit; `AUDIT_ACTIONS` covers six tenant-side actions only.
12. No service-credential rotation endpoint (webhook secrets have one).
13. The reviewer app's §9.1 projection is written against a payload shape the
    backend does not send — assignment, profile and the reviewer-state vocabulary
    all disagree, and two endpoints the app calls do not exist. Full list in ADR
    0002's gaps. No test feeds a backend payload to an app projection.
14. Nothing asserts the absence of an HTML/`WebView`/`eval` sink in the reviewer
    app.
15. `startAssignmentExpirySweep` is the only thing that expires an assignment, and
    the shared-Valkey leader guard that will matter when a queue exists is not in
    `deploy-aws.yml`.
16. The reporter fingerprint is domain-separated, not keyed — an application can
    recompute its own users' fingerprints. **The digest is unchanged and this stands.**
    Containment is that no surface returns them at any role; making it keyed is a
    migration, not an edit. (The misleading "salted" comments are corrected in the
    uncommitted `phase9/console` worktree, which changes the documentation and not
    the mechanism.)
17. ~~`DRIVER_ACCESS_ALLOWED` is not pinned to an exact set by any test.~~ **Pinned
    in the uncommitted `phase9/console` worktree**, and pinned *before* the new
    privileged module joined the list. Reopen this if it does not survive the merge —
    it is the guard on the escape hatch §7 depends on.
18. There is no `Incident` collection or module, so `AGENTS.md`'s "cross-tenant
    correlation happens ONLY through `Incident`" names a chokepoint that does not
    exist — and once the §7 read lands that sentence is wrong on both halves and on
    its caller axis too (it constrains "application-API caller"; the new module
    serves a **staff session**). See ADR 0001 §5 *In flight*.
19. `AUDIT_ACTIONS` has no entry that could record a Trust & Safety read. The
    uncommitted work answers this with a **separate `staff_audit_events`
    collection** rather than an entry, because a staff read spans every tenant at
    once and one row cannot honestly belong to one tenant — so this gap closes by a
    different shape than the one it was written against.
20. Three unique indexes are owed with the tenancy work and are not in `AGENTS.md`'s
    list: `organizationId + oxyUserId` on membership, `applicationId + day` on the
    usage counter, `oxyUserId` on `trust_safety_staff`. The first has teeth: without
    it two concurrent invitations give one person two role rows and every later
    permission check answers whichever Mongo returns first — an intermittent
    authorization bug, not a visible duplicate.
21. **The juror collections (`Assignment`, `Review`, `ReviewerProfile`,
    `SortitionDraw`, `ReviewerAffinity`, `ReviewerRelation`) are unscoped, so they
    are already readable across every tenant with no filter.** The exemption is
    justified — a reviewer belongs to no tenant — and the rows do carry their case's
    tenant, but nothing enforces it on read. Juror identity is therefore protected
    today only by no module asking, which is not a control. §7's named-query
    projection does not cover these collections, because they need no cross-tenant
    primitive to be read across tenants.

## Checks worth adding

Struck-through entries below are written. Only the contract test between the
assignment package and the reviewer projection is still unclaimed.

- ~~**A no-injection-sink scan.**~~ **Written**, as `scripts/check-injection-sinks.mjs`
  — the `check:injection-sinks` script, inside `bun run check`, with
  `scripts/test-check-injection-sinks.mjs` mutation-testing it in CI's "Verify
  release and CI safeguards" step. It fails when any package introduces
  `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`,
  `document.write`, a `WebView` component, `eval(`, `new Function(` or a
  string-bodied `setTimeout`. This is the only thing that would notice §3's fourth
  control being lost. Two vacuity floors, not one: a scanned-file count
  (`--min-files=200`) and a per-package floor, because a walk that reached only
  `packages/contracts` would clear a file count set low enough to survive ordinary
  churn. The two known false positives are excluded BY CONSTRUCTION rather than by
  an allowlist entry, and both are pinned as mutation cases — `WebViewStyle` in
  `packages/reviewer/types/webStyles.ts` (the word boundary in `\bWebView\b`
  separates them) and `evaluateConsensus` in the consensus module (`\beval\s*\(`
  requires the call). The allowlist is empty on purpose: the first entry is a
  visible edit, and it is for real sinks that are genuinely safe, which neither of
  those is.
- **A contract test between the backend's assignment package and the reviewer
  app's projection.** One fixture produced by `reviewPackage` fed to
  `projectAssignmentPackage`. It would have caught gap 13 the day it appeared, and
  it is the check that makes the §9.1 allowlist a live guard rather than a
  well-written intention.
- ~~**Pin `DRIVER_ACCESS_ALLOWED` to an exact set**, beside the assertion that
  already pins `unscopedCollectionReasons()`.~~ **Written** in
  `collectionBoundary.test.ts` in the `phase9/console` worktree, and landed before
  the privileged module joined the list — so the precedent is "an entry arrives with
  a test change" rather than the reverse.
- ~~**Assert each §7 named query's projection against a document carrying every
  forbidden field**, written to fail when a field is ADDED rather than merely
  confirming the expected fields are present — a presence-only assertion passes a
  query that returns everything.~~ **Written** as
  `packages/backend/src/__tests__/crossTenantReads.test.ts`. Worth confirming on
  review that it fails on an added field, since that is the property that
  distinguishes "the projection is inside the query" from "the projection is at the
  screen".
