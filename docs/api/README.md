# API

Everything CrowdSource serves is under `/v1` on `https://api.crowdsource.oxy.so`
(`packages/backend/src/app.ts`). There is one deployment: no sandbox host, no
staging host. An application's own pre-production is a property of the *report*
(`source.environment`), not a different service to talk to.

| Document | Caller |
| --- | --- |
| [`application.md`](./application.md) | An application, holding a **service credential**. |
| [`reviewer.md`](./reviewer.md) | A reviewer, holding an **Oxy session**. |
| [`console.md`](./console.md) | A developer with an **organization membership**, and Trust & Safety with a **staff role**. |
| [`webhooks.md`](./webhooks.md) | Not a caller — what CrowdSource sends *you*. |

The request and response *documents* are published as Zod schemas and generated
JSON Schema by `@oxyhq/crowdsource-contracts`, which is the same package the
server validates with. Where a shape below is not in that package — the HTTP
error body, the report receipt, the case view — it is a shape the backend
composes in the route file, and each section names the file.

## Four caller classes, and none of them substitutes for another

This is the part of the API easiest to get wrong when reading it quickly, so it
is stated first. There are **two authentication mechanisms**, and on top of the
second, **three authorizations**.

| Class | Presents | Established by | Reaches |
| --- | --- | --- | --- |
| Application | `Authorization: Bearer <credentialId>.<secret>` | `modules/tenancy/credential.service.ts` | `/v1/reports`, `/v1/cases`, `/v1/decisions`, `/v1/cases/{id}/appeals`, `/v1/webhook-endpoints` |
| Reviewer | An Oxy session | `modules/identity/oxySession.ts` + `modules/reviewer/reviewerAuth.ts` | `/v1/reviewer/*` |
| Developer | An Oxy session **and** an active organization membership | `modules/console/membership.service.ts` | `/v1/console/*` |
| Trust & Safety | An Oxy session **and** a staff role | `modules/console/consoleAuth.ts` | `/v1/trust-safety/*` |

Three properties hold these apart, and each is structural rather than a rule
somebody remembers at each route:

- **A service credential cannot satisfy a session route.** Session verification
  is `createOptionalOxyAuth` from `@oxyhq/core/server`
  (`modules/identity/oxySession.ts`), which does not recognise a CrowdSource
  service token as an Oxy session, so the guard behind it answers `401`. A
  leaked integrator key therefore cannot read a console or an assignment.
- **An Oxy session cannot satisfy an application-API route.**
  `requireServiceCredential` (`modules/tenancy/serviceCredentialAuth.ts`) parses
  the bearer as `<credentialId>.<secret>` and looks that credential up; an Oxy
  access token is not one, and every rejection is the same `401` with the same
  message.
- **A verified session by itself grants nothing.** Every Oxy account in
  existence authenticates. A reviewer profile is created on first sight in the
  `applicant` state and can decide nothing; a membership is granted by an
  organization `admin`; a staff role has **no HTTP route at all** and is created
  out of band, deliberately (`modules/console/staff.service.ts`).

The tenant follows from the class and is never named by the caller. An
application's `applicationId` comes off its credential
(`credential.service.ts:135`). A console caller names an *application id in the
path*, and `organizationId` is read from the stored row before a membership is
checked (`console/membership.service.ts`, `resolveApplicationForMember`). A
reviewer carries no tenant at all — a juror is drawn across every application by
design.

## Errors

One shape, from `http/errorHandler.ts`, for every failure the service produces:

```json
{ "error": { "code": "conflict", "message": "…", "details": {} } }
```

`details` is present only when the failure has machine-readable context, and
carries scalars only — never reported material (`http/apiError.ts`,
`ApiErrorDetails`).

| Code | Status | Means |
| --- | --- | --- |
| `invalid_request` | 400 | The request is malformed — a missing `Idempotency-Key`, a body that is not JSON. |
| `unauthorized` | 401 | No usable credential or session. Answered with `WWW-Authenticate: Bearer realm="crowdsource"`. |
| `forbidden` | 403 | Authenticated, and the capability is not granted — a missing scope, too small a seat, a missing staff role. |
| `not_found` | 404 | No such object **or** not yours. Deliberately indistinguishable. |
| `conflict` | 409 | The same `externalReportId` arrived with a different body. |
| `payload_too_large` | 413 | Over the 1 MB body limit. |
| `unprocessable_envelope` | 422 | The document did not satisfy the contract. |
| `rate_limited` | 429 | Over the application's daily report quota. |
| `internal_error` | 500 | A defect on our side. The message is never the underlying error. |
| `service_unavailable` | 503 | A dependency this surface needs is not configured or not reachable. |

**Retry `408`, `425`, `429`, `500`, `502`, `503`, `504`. Do not retry anything
else** — that split is `RETRYABLE_STATUSES` in `packages/sdk/src/errors.ts`, and
`@oxyhq/crowdsource` exposes it as a `retryable` boolean on every error it
throws, so a delivery worker never has to re-derive it.

`401` and `403` are not interchangeable. A credential that authenticates but
lacks a scope is `403`, so an integrator adds the scope rather than rotating a
working key (`serviceCredentialAuth.ts`).

## What is not served

Naming these is the point of this section: an endpoint that is absent should be
absent from the documentation too, or the next person builds against it.

- **No upload route.** Evidence is a bare Oxy `fileId` resolved through the
  ecosystem media chokepoint; `packages/sdk/src/uploads.ts` was removed rather
  than a server half built. See [`application.md`](./application.md#evidence).
- **No case search, and no reviewer route that takes a case id.** Every reviewer
  route is addressed by assignment (`modules/sortition/assignments.routes.ts`),
  which is what makes "nobody chooses the case they review" a property of the
  routing table rather than a rule.
- **No webhook endpoint list, read-back or delete on the application API.** The
  plan defines two routes and two exist. The list is on the console surface
  instead (`GET /v1/console/applications/{id}/webhook-endpoints`).
- **No enforcement route and no reputation bridge.**
  `crowdsource:enforcement:write`, `crowdsource:policies:manage` and
  `crowdsource:schemas:manage` are grantable scopes
  (`modules/tenancy/scopes.ts`) with no route behind them yet.
- **No route that grants a Trust & Safety role**, deliberately.
