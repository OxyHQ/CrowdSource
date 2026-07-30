# Application API

The surface an application talks to, authenticated by a **service credential**.
An Oxy session never satisfies any route here — see
[the four caller classes](./README.md#four-caller-classes-and-none-of-them-substitutes-for-another).

Most integrators should not write these calls by hand. `@oxyhq/crowdsource`
composes the envelope, the digests, the principal refs and the idempotency key,
and getting any of those wrong has consequences that surface days later. This
document is the contract underneath it, for people debugging it or writing a
client in another language.

## Authentication

```
Authorization: Bearer <credentialId>.<secret>
```

That is the token `POST /v1/console/applications/{id}/credentials` returns as
`token`. It is **not** the same string as `CROWDSOURCE_SERVICE_KEY`, which is
`applicationId:credentialId:secret` — see
[the integration guide](../integration.md#the-service-key-has-three-parts-and-the-console-shows-two).

`applicationId` is derived from the credential
(`modules/tenancy/credential.service.ts`) and from nowhere else. The Case
Envelope carries a copy so a mismatch can be **detected**: ingress compares it
to the credential-derived id and refuses with `403` plus an
`application_mismatch` audit row (`modules/ingestion/envelopeValidation.ts`).

Every authentication failure is the same `401` with the same message, whether
the credential id was unknown, the secret wrong, the credential revoked or
expired, or the application suspended. The distinction is in the operator's
audit trail, not in the response.

## Scopes

Named at the mount point of each route, so what a route needs is visible where
it is declared. Grantable to an application credential
(`modules/tenancy/scopes.ts`, `APPLICATION_SCOPES`):

`crowdsource:reports:write` · `crowdsource:reports:read` ·
`crowdsource:cases:read` · `crowdsource:appeals:write` ·
`crowdsource:enforcement:write` · `crowdsource:webhooks:manage` ·
`crowdsource:policies:manage` · `crowdsource:schemas:manage`

Not grantable at any seat (`PRIVILEGED_SCOPES`): `crowdsource:decisions:emit`,
`reputation:moderation:apply`, `crowdsource:trust-safety:operate`. Asking for
one is refused rather than filtered out, at both the console's request schema
and in `issueApplicationCredential` — a caller that believed it was getting the
ability to move a reputation figure must not be handed a lesser credential
quietly.

The last three grantable scopes have **no route behind them yet**. A credential
holding `crowdsource:enforcement:write` can do nothing with it today.

## Routes

| Method | Path | Scope |
| --- | --- | --- |
| POST | `/v1/reports` | `crowdsource:reports:write` |
| GET | `/v1/reports/{reportId}` | `crowdsource:reports:read` |
| GET | `/v1/cases/{caseId}` | `crowdsource:cases:read` |
| POST | `/v1/cases/{caseId}/appeals` | `crowdsource:appeals:write` |
| GET | `/v1/decisions/{decisionId}` | `crowdsource:cases:read` |
| POST | `/v1/webhook-endpoints` | `crowdsource:webhooks:manage` |
| POST | `/v1/webhook-endpoints/{webhookEndpointId}/rotate-secret` | `crowdsource:webhooks:manage` |

That is the whole application API. There is no list route, no search route and
no delete route anywhere on it.

---

## `POST /v1/reports`

`Idempotency-Key` is **required** (`modules/ingestion/reports.routes.ts`), 1–255
characters of `[A-Za-z0-9._:-]`. A missing or malformed one is `400`. The SDK
sends `report.<externalReportId>`.

Body: `{ externalReportId, envelope }` — the envelope is
`CaseEnvelopeSchema` from `@oxyhq/crowdsource-contracts`, and the outer
`externalReportId` must equal the one inside it.

Answers **`202`** and only `202`:

```json
{ "reportId": "…", "caseId": "…", "status": "received", "merged": false }
```

`status` is one of `received`, `merged`, `invalid`, `withdrawn`, `closed`
(`REPORT_STATUSES`). `merged` is true when this report joined a case another
report had already opened.

**`202` means the report is stored and durable rows exist for everything that
happens next.** It does not mean a jury exists, a panel was drawn, or anything
downstream ran. The decision arrives later, over a webhook.

Call it **from your own delivery worker, not from the request handler that
answered the user.** A `2xx` from *your* application means the report is stored
locally with a retry path; this call is what eventually makes it CrowdSource's
problem, and it is allowed to fail.

### The failures worth handling separately

| Status | When |
| --- | --- |
| `409` | The same `externalReportId` arrived with a **different** body. Ingress fingerprints the whole `{ externalReportId, envelope }`. Not retryable — the payload has to change. |
| `422` | The envelope did not satisfy the contract. |
| `403` | The envelope names a different `applicationId` than the credential, or the application's standing is `restricted`. |
| `429` | Over the standing's `reportsPerDay`. |

The `409` is the one that bites. **Nothing your client composes may vary between
two deliveries of the same report** — an invented timestamp, a random resource
id, an unsorted list. The symptom is not an error anybody sees at integration
time; it is a legitimate outbox retry becoming a permanent `409` days later,
surfacing as moderation work stuck in a queue. This is why the SDK derives
resource ids positionally, derives principal refs from the identity, and gives
`source.submittedAt` no default.

Ingress refusals are audited before they are thrown, with a closed reason code:
`schema_invalid`, `application_mismatch`, `unsafe_resource_url`,
`policy_unknown`, `payload_conflict` (`modules/audit/audit.collection.ts`).

## `GET /v1/reports/{reportId}`

```json
{ "reportId": "…", "externalReportId": "…", "caseId": "…",
  "status": "received", "receivedAt": "2026-07-30T00:00:00.000Z" }
```

A read that hits writes a `report.receipt.read` audit row. A miss writes
nothing: a `404` is indistinguishable from "belongs to another tenant" by
design, so auditing misses would fill one tenant's trail with another tenant's
probing.

## `GET /v1/cases/{caseId}`

An application may look up a case it was given the id of. There is **no case
search and there will not be one**.

```json
{ "caseId": "…", "status": "…", "subject": { "externalId": "…", "type": "social.post" },
  "policy": { "policySetId": "crowdsource.baseline", "version": "2026.07" },
  "taxonomyVersion": "2026.1", "allegationCodes": ["…"], "reportCount": 1,
  "sensitivityClass": "standard", "currentRevision": 1,
  "decision": null, "createdAt": "…", "updatedAt": "…" }
```

`decision` is the revision currently in force, or `null` before one is
published. A superseded revision stays readable by id, and
`supersedesDecisionId` chains backwards through every revision.

Withheld deliberately (`modules/cases/case.service.ts`, `findCaseView`):
`priorityScore` and `reviewPool` (internal queue position and specialist
routing — an application could game them), `reporterFingerprints`,
`contentSnapshot`, and `incidentId`.

## `GET /v1/decisions/{decisionId}`

Returns `DecisionSchema` from the contracts package:

- `id`, `caseId`, `revision`, `status` (`provisional` | `final` | `superseded` |
  `corrected`), `publishedAt`
- `outcome` — one of `violation`, `no_violation`, `insufficient_context`,
  `inconclusive`, `content_unavailable`, `duplicate`, `escalated`
- `contextSufficiency`, `confidence`
- `findings[]` — `{ code, resourceIds, severity, scope, context?, attribution?,
  policyRuleIds? }`
- `recommendedActions[]` — `{ action, targetResourceIds? }`. Objects, not bare
  strings: a decision recommending removal without saying what to remove is not
  actionable. `targetResourceIds` is absent for the actions that are about the
  case rather than a resource (`escalate`, `no_global_effect`, `no_action`).
- `jury` — `{ size, decisiveVotes, winningVotes, agreement, specialistPresent }`.
  **Aggregates only.** No reviewer id, no individual vote, ever.
- `policyVersions` — `{ taxonomy, application, oxyConduct }`, all three, always
- `supersedesDecisionId` — absent on revision 1, required after it

**A published decision is never edited, only superseded.** An appeal opens a new
revision that supersedes the old one; the old one keeps its id and its content.

`inconclusive` is its own outcome and must never be presented as, or grouped
with, `no_violation`. Absence of consensus is neither guilt nor innocence.

## `POST /v1/cases/{caseId}/appeals`

Also requires `Idempotency-Key`, for the same reason: two appeals of two
different revisions can carry byte-identical content, so content cannot tell a
retry from a new filing.

```json
{ "appellantExternalPrincipalId": "…",
  "reason": "policy_misapplied",
  "authorContext": { "statement": "…", "resourceIds": ["res_subject"], "fields": {} } }
```

`reason` is one of `context_missing`, `policy_misapplied`, `finding_incorrect`,
`exception_applies`, `not_responsible`, `procedural_error`.

`201` on a filing, `200` on a retry of one already stored. The appeal and the
revision it opened both exist by the time this answers; what is asynchronous is
the jury.

Three independent facts must hold, and none substitutes for another
(`modules/appeals/appeals.routes.ts`):

1. the credential holds `crowdsource:appeals:write`;
2. the case belongs to that tenant, is decided at its current revision, and the
   decision carries an appealable consequence — `violation`, `inconclusive` or
   `insufficient_context` (`modules/appeals/appeal.service.ts`,
   `APPEALABLE_OUTCOMES`);
3. `appellantExternalPrincipalId` appears in the case's
   `contentSnapshot.principals` — the principals the reported **material**
   points at. A reporter is referenced by an allegation and never by the
   material, so a reporter cannot appeal a decision that went against somebody
   else.

The application files on the author's behalf because CrowdSource never sees an
application's users. `authorContext.statement` is redacted once, at ingress, and
the raw bytes are never stored: URLs removed, bidi overrides and zero-width
characters stripped, contact details and identifier-shaped numbers masked. The
hostile text itself survives — an author defending a post that quoted a threat
has to be able to quote it back. See
[the appeals ADR](../architecture/appeals.md) for every choice and its reason.

## `POST /v1/webhook-endpoints`

```json
{ "url": "https://example.com/webhooks/crowdsource", "eventTypes": ["case.decided"] }
```

`201` when the endpoint was created, `200` when an existing URL was updated.
**An update mints no secret**, which is what makes this safe to run on every
boot — re-registering will never invalidate the secret your running process is
verifying with. The corollary: re-registering cannot *recover* a secret you
failed to store.

```json
{ "webhookEndpointId": "…", "url": "…", "eventTypes": ["case.decided"],
  "status": "active", "disabledReason": null, "createdAt": "…", "updatedAt": "…",
  "secret": { "version": 1, "value": "…", "signingStartsAt": "…" } }
```

`secret` is present **only when this call minted one**, and appears in that one
response and nowhere else ever.

`503` when the deployment has no usable `WEBHOOK_SECRET_ENCRYPTION_KEY`: an
endpoint that existed without a secret could never be delivered to, and the
failure would surface days later as silence.

## `POST /v1/webhook-endpoints/{id}/rotate-secret`

```json
{ "overlapSeconds": 28800 }
```

`0` is an immediate cutover, which is what a leak needs. Omitted, the default is
a working day.

```json
{ "webhookEndpointId": "…",
  "secret": { "version": 2, "value": "…", "signingStartsAt": "…" },
  "previousSecret": { "version": 1, "expiresAt": "…" } }
```

`signingStartsAt` is what makes the overlap a procedure rather than a guess:
deliveries begin carrying the new signature at that instant, and the old secret
stays valid until `previousSecret.expiresAt`. Serve both in between and no
delivery is dropped — `@oxyhq/crowdsource-express` reads the retiring one from
`CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS`.

## Evidence

**There is no upload route, deliberately.** An asset carries a bare Oxy
`fileId`; the bytes live behind the one Oxy media chokepoint the ecosystem
already uses, so there is no second place for bytes to be, no presigned URL to
leak and no bucket to configure.

```ts
attachments: [{
  type: 'image',
  asset: {
    fileId: post.imageFileId,        // bare Oxy file id — never a URL
    mimeType: 'image/jpeg',
    sha256: `sha256:${digestOf(bytes)}`,
    url: post.remoteImageUrl,        // optional provenance. Never fetched.
  },
}]
```

`asset.url` is a **provenance record and never a fetch target**. Nothing
resolves it. Fetching it would tell that host exactly when its content is under
review, and would deliver live bytes instead of the version the case pins.

**Gap, stated because a documented protection that does not exist is worse than
an acknowledged one:** nothing copies evidence bytes into storage CrowdSource
controls, and nothing verifies a fetched stream against the declared `sha256`.
`packages/backend/src/modules/evidence/` contains one file,
`contentSnapshot.ts`, which snapshots and hashes *inline text* resources; binary
evidence is referenced and never fetched. A `fileId` resolves to whatever
`cloud.oxy.so` currently serves, so **an author who deletes an image removes it
from the reviewer's screen** mid-case. The reviewer is told plainly and
`insufficient_context` and recusal stay open, which bounds the damage without
removing it.

## Machine-checked claims

Compared against the code by
`packages/backend/src/__tests__/docsClaims.test.ts`. The route table above is
checked too — every documented row must exist, every served route must be
documented, and every one of them must be behind a service credential.

```docs-claims
application-scopes: crowdsource:reports:write, crowdsource:reports:read, crowdsource:cases:read, crowdsource:appeals:write, crowdsource:enforcement:write, crowdsource:webhooks:manage, crowdsource:policies:manage, crowdsource:schemas:manage
privileged-scopes: crowdsource:decisions:emit, reputation:moderation:apply, crowdsource:trust-safety:operate
decision-outcomes: violation, no_violation, insufficient_context, inconclusive, content_unavailable, duplicate, escalated
report-statuses: received, merged, invalid, withdrawn, closed
appealable-outcomes: violation, inconclusive, insufficient_context
appeal-reasons: context_missing, policy_misapplied, finding_incorrect, exception_applies, not_responsible, procedural_error
decision-finding-fields: code, resourceIds, severity, context, scope, attribution, policyRuleIds
error-codes: invalid_request, unauthorized, forbidden, not_found, conflict, payload_too_large, unprocessable_envelope, rate_limited, internal_error, service_unavailable
ingress-refusal-reasons: schema_invalid, application_mismatch, unsafe_resource_url, policy_unknown, payload_conflict
evidence-module-files: contentSnapshot.ts
```
