# Console API

Two routers, one authentication, three authorizations. `/v1/console/*` serves an
application's own team; `/v1/trust-safety/*` serves Oxy staff across tenants.

Both are **Oxy session** callers. A service credential satisfies neither: the
shared SDK does not recognise a service token as a session, so it never reaches a
handler. That is the structural half of the separation — a leaked integrator key
cannot read a console.

## The three authorizations

| What | Where | What a verified session alone grants |
| --- | --- | --- |
| Reviewer profile | `reviewerAuth.ts` | created on first sight; `applicant` state |
| Organization membership | `console/membership.service.ts` | nothing |
| Trust & Safety role | `console/consoleAuth.ts` | nothing |

Every Oxy account in existence authenticates. A membership is granted by an
`admin` of the organization; a staff role has **no HTTP route at all** and is
created out of band, deliberately — §13.2 requires privileged authority not to be
self-grantable, and the way to guarantee that is for there to be no route.

## How a tenant is established

A console caller names a resource (`/console/applications/app_…`) and never names a
tenant. Per request:

1. the path gives an application id;
2. the application row is read by that id, and `organizationId` is taken **from the
   stored row**;
3. an active membership of that organization is required for the authenticated Oxy
   user, or the answer is `404`;
4. only then is a `TenantContext` constructed, from the stored row's two ids.

No handler reads an `organizationId` from a body or query string. Every body schema
is a Zod `strictObject`, so an unexpected key is a `400` rather than a field that
reaches a document.

## Status codes

`404` on an application route means "not yours **or** not there" — deliberately
indistinguishable, so the route cannot be used to enumerate Oxy's customers. `403`
means membership is established and the seat is too small, or on Trust & Safety
that the role is missing. Otherwise §10.5's conventions apply unchanged.

## Seats

`owner` > `admin` > `developer` > `viewer`. Reading needs `viewer`. Anything that
changes production behaviour needs `admin`: issuing or revoking a credential,
rotating a webhook secret, replaying a delivery, granting or revoking a member,
creating an application. The last `owner` of an organization cannot be revoked — an
organization with no owner has no self-service path back.

## Developer routes

| Method | Path | Seat |
| --- | --- | --- |
| GET | `/v1/console/session` | any |
| GET | `/v1/console/organizations` | any |
| POST | `/v1/console/organizations` | any (creator becomes `owner`) |
| GET | `/v1/console/organizations/{id}/members` | viewer |
| POST | `/v1/console/organizations/{id}/members` | admin |
| POST | `/v1/console/organizations/{id}/members/{oxyUserId}/revoke` | admin |
| GET | `/v1/console/organizations/{id}/applications` | viewer |
| POST | `/v1/console/organizations/{id}/applications` | admin |
| GET | `/v1/console/applications/{id}` | viewer |
| GET | `/v1/console/applications/{id}/credentials` | viewer |
| POST | `/v1/console/applications/{id}/credentials` | admin |
| POST | `/v1/console/applications/{id}/credentials/{credentialId}/revoke` | admin |
| GET | `/v1/console/applications/{id}/webhook-endpoints` | viewer |
| POST | `/v1/console/applications/{id}/webhook-endpoints/{endpointId}/rotate-secret` | admin |
| GET | `/v1/console/applications/{id}/deliveries` | viewer |
| GET | `/v1/console/applications/{id}/deliveries/{deliveryId}` | viewer |
| POST | `/v1/console/applications/{id}/deliveries/{deliveryId}/replay` | admin |
| GET | `/v1/console/applications/{id}/cases` | viewer |
| GET | `/v1/console/applications/{id}/cases/{caseId}` | viewer |
| GET | `/v1/console/applications/{id}/usage` | viewer |
| GET | `/v1/console/applications/{id}/audit` | viewer |

Values shown once and never re-served: a service token (`POST …/credentials`) and a
rotated webhook secret. Only a SHA-256 of the first is stored, so nothing —
including this service — can recover it.

Four of these writes append to the tenant's own audit trail with the acting member's
Oxy id and the id of what they acted on: `console.credential.issued`,
`console.credential.revoked`, `console.webhook.secret.rotated`,
`console.delivery.replayed`, plus `console.application.created`. The actor fields are
separate — `actorCredentialId` for a service credential, `actorOxyUserId` for a
person — because "the leaked key did it" and "this member of your team did it" are
different incidents.

**§13.2's step-up authentication is not implemented.** The clause asks that
irreversible and export actions require a second, stronger authentication; that needs
a capability from Oxy's identity layer, and a locally invented one would be a second
definition of what authentication means here. An `admin` seat authorizes these actions
and the trail records them.

A membership change is **not** in the trail: a seat is organization-scoped and
`audit_events` is application-scoped. What exists is on the membership row —
`invitedByOxyUserId`, `status`, `revokedAt` — which is not append-only, since a
re-grant overwrites the previous inviter. An organization-scoped audit collection is
the fix.

`GET …/webhook-endpoints` closes a real gap: §10.2 defines no endpoint list, so an
integrator holding only a service credential cannot see what it has registered. The
list lives on the session surface rather than widening the application API.

## What a developer's case view contains

A superset of the application API's case view along exactly two axes — resource
**metadata** and the decision **history** — and neither adds a category of
information the tenant did not already hold.

Never returned, at any seat:

- a reviewer identity in any form, or a count of who sat on a panel;
- an individual juror's vote or review record;
- `reporterFingerprints` — domain-separated by the application's own id over its own
  principal ids, and keyless, so an application handed them could recompute them over its
  user table and de-anonymise its reporters;
- reported content: resource `data` never leaves, only `{ id, type, role, language,
  sha256 }`;
- `priorityScore` and `reviewPool` (internal queue position and specialist routing);
- `incidentId` (cross-application correlation).

Aggregate jury figures — size, decisive votes, winning votes, agreement — DO appear
on a decision, because the application API and §10.7's webhook envelope already
publish them. The per-field reasoning is in
`packages/backend/src/modules/console/caseExplorer.service.ts`.

`inconclusive` is its own outcome. It must never be presented as, or grouped with,
`no_violation`.

## Trust & Safety routes

| Method | Path | Role |
| --- | --- | --- |
| GET | `/v1/trust-safety/applications` | `security` or `policy` |
| POST | `/v1/trust-safety/applications/{id}/standing` | `security` |
| GET | `/v1/trust-safety/escalated` | `security`, `policy` or `appeals` |
| GET | `/v1/trust-safety/deliveries/dead-letter` | `security` |
| GET | `/v1/trust-safety/metrics` | `security` or `policy` |

Every one of them appends a row to `staff_audit_events` naming the operator, the roles
they held **at the time**, and at most one application id. That trail is a separate
collection from `audit_events` because a staff read spans every tenant at once: filing it
in a tenant-scoped trail would force a choice between an incomplete record and filling
every customer's trail with somebody else's activity. §13.1 lists append-only audit as the
only control against insider abuse, and an unauditable privileged surface has none.

Standing is `sandbox` (every new application), `trusted`, or `restricted`. It is not
the tenant's to change — the point of standing is to be a judgement made about an
application by somebody other than its owner.

`globalReputationEffectsAllowed` may be **withheld** at a standing that permits it,
but never granted beyond what the standing's quota allows: the server intersects the
request with the table, so §16.2's "a sandbox application cannot produce global
effects" holds regardless of what was asked for.

The three §11.13 quality signals — `evidenceIntegrity`,
`identityBindingReliability`, `policyQuality` — are `null` because nothing measures
them yet. They are null and not `0` on purpose: a fabricated score on an operator
screen looks like a measurement and gets acted on.

### How cross-tenant reading is expressed

`cases` and `decisions` are tenant-scoped collections with no unscoped read, and they must
not gain one. The cross-tenant reads Trust & Safety needs therefore live in ONE module,
`src/modules/trust/crossTenantReads.ts`, named in `DRIVER_ACCESS_ALLOWED` as a single file
rather than a directory, and pinned by two tests: the allowlist's exact set, and the exact
set of modules permitted to import it.

It exposes **specific named queries, never a filter parameter**. A general
`findAcrossTenants(filter)` would control who may call but not what they may ask, so a new
cross-tenant read would arrive as a new filter passed to an already-sanctioned call —
invisible in a diff. Each query's projection is declared as data (`ESCALATED_QUEUE_FIELDS`)
and asserted disjoint from `CROSS_TENANT_FORBIDDEN_FIELDS`, so widening one fails a test
that names the field.

The escalated queue returns triage fields only: case id, organization, application, status,
allegation codes, sensitivity class, review pool, priority, timestamps. `reviewPool` and
`priorityScore` appear here and are withheld from every tenant-facing view — an operator
running the queue needs them and an application could game them.

The metrics are **scalars**: counts per case status, counts per decision outcome, review
totals, delivery counts, and `inconclusiveRate`. An aggregate that never returns a document
cannot leak one. `inconclusive` is counted on its own axis and never folded into
`no_violation`.

`unavailable` still names what genuinely cannot be computed: `case_queue_age_seconds`
(a time-window aggregation, not a count), `appeal_rate` and `overturn_rate` (both need
appeals, which are not built — an appeal is what creates the second decision revision they
are computed from), and `reviewer_exposure_units` (per-reviewer, which no cross-tenant read
returns by design). §4.3's cross-application **incidents** are also absent: §12.9 puts that
correlation behind an `Incident` object that does not exist and nothing sets `incidentId`.

### Juror data is protected by FIELDS, not by the tenant

`Assignment`, `Review`, `ReviewerProfile`, `SortitionDraw`, `ReviewerAffinity` and
`ReviewerRelation` are unscoped collections — correctly, since a reviewer belongs to no
tenant and the draw spans every application by design. So the tenant filter is not the
control for juror data and cannot be, and a module wanting juror identity across tenants
needs no allowlist entry at all: it can read `Review` through the ordinary wrapper.

The control is the fields. No console-reachable accessor returns a `reviewerId`, an
assignment, or a per-juror vote — `summariseReviewActivityAcrossTenants` returns counts and
nothing else, and the forbidden-field list names juror identity explicitly so a rename
cannot quietly drop it. A group-by-reviewer aggregation would be one field away from naming
somebody; a count cannot name anybody whatever is added to it.

## Quotas

Per standing, in `packages/backend/src/modules/trust/quota.ts`. Enforced, not
advertised:

- `reportsPerDay` — checked at ingress against a per-day counter incremented inside
  the report's own transaction. Over it, `POST /v1/reports` answers `429`; a
  `restricted` application answers `403`, because retrying will not help.
- `webhookEndpoints` — checked when an endpoint is created. A guardrail against
  fan-out amplification, not a rationing device; re-registering a URL the
  application already has is exempt.
- `globalReputationEffects` — the gate the reputation bridge will read. Nothing
  calls it yet, because the bridge is not built.
