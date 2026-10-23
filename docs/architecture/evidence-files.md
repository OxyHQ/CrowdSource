# Evidence files

A case's binary evidence — an image, video, audio or document resource — names
its bytes by a bare Oxy file id. This page is how CrowdSource adopts Oxy Files'
model of ownership, usage and lifecycle (oxy ADR 0043, "Who owns a file, who uses
it, and when it goes away") for those ids: who may submit one, how Oxy is told a
case uses it, how the record is kept exact, and what happens when Oxy says a file
may no longer be shown.

The code is `packages/backend/src/modules/evidence/` (`evidenceFiles.ts`,
`oxyFiles.ts`, `evidenceReferences.ts`, `fileEvents.service.ts`,
`fileEvents.routes.ts`), with the statements in
`db/postgres/repositories/evidenceFiles.ts` and the tables in
`db/postgres/schema/evidence.ts` (migration `0020_oxy_file_references`, `pre`).

## 1. Submitting: the evidence must be the tenant's own

`POST /v1/reports` asks Oxy (`OxyServer.assets.metadataByIds`, scope
`files:read`) about every evidence file in the envelope and refuses the report
(`422 unprocessable_envelope`, audited `report.ingress.rejected` /
`evidence_unverified`) unless each file is:

- **owned by the tenant** — by the tenant application's bound Oxy application
  (`applications.oxy_application_id`) or by the tenant organization's Oxy account
  (`organizations.oxy_account_id`);
- **active**; and
- **the bytes declared** — Oxy's stored SHA-256 equals `asset.sha256`.

"No such file", "not yours" and "not active" are one answer with one message, so
the check is not an oracle for other people's file ids.

It fails **closed**. Oxy unreachable, this service without `files:read`, or an
answer that does not reveal owners — Oxy reveals `ownerUserId` and
`ownerApplicationId` only to its own (`tier: 'internal'`) applications — is a
`503`: the integrator retries and nothing unchecked is stored.

It is the one ingress check whose answer can change between two deliveries of
one report (a file can be deleted after the report was stored), so a refusal
first looks for this exact delivery among the stored reports and answers a retry
of a stored report as the replay it is.

**Why ownership.** A reviewer's client renders whatever file id a case carries,
and a case keeps the files it names alive at Oxy (§2). Without the check an
application could put anybody's file in front of a jury and pin it there. And an
owned copy is what makes the evidence the case's own: the reported content's
author never owned it, so cannot take it down mid-case.

## 2. Using: a reference per (case, file)

The report's transaction inserts one `case_evidence_files` row per evidence file
of the case (a merged report carries the same files, so it adds nothing). The row
is born with its reference `pending` and is the durable record of that work — the
same rule as the outbox: a case can never exist whose files Oxy was never told it
uses.

The **reference worker** (every task, every 5 seconds) claims due rows across
every tenant under a lease (`FOR UPDATE SKIP LOCKED`), and calls
`OxyServer.assets.references.add` (scope `files:references:write`) with entity
type `case` and the case id as entity id, in batches of 100. Each outcome is
written only while the worker's claim still holds and the row still asks for what
was claimed, so a file event that lands mid-call is never overwritten.

| Oxy answers | The row becomes |
| --- | --- |
| `created`, `exists` | `registered` |
| `not_found` (another application's private file, or not active) | `refused` — withheld from the jury, audited `evidence.withheld` / `file_unreferenceable` |
| an error, or no answer for the row | still owed: retried after 30 s, doubling to an hour, never dropped |

A held reference is what pins the evidence: the owning application cannot delete
a file a case uses (Oxy answers `409 FILE_IN_USE`), and Oxy's lifecycle never
garbage-collects an application's file that is referenced.

**Removal.** A deleted file owes the removal of CrowdSource's reference
(`removal_pending`, then `references.remove` → `removed`), so Oxy's record of who
uses what stays exact. Nothing else removes a reference today, because nothing
deletes a case: case retention is not built (`account-erasure.md`), and the
references live exactly as long as the cases.

## 3. Reconciling: the nightly safety net

Every task checks hourly whether the night's run is due; one takes a lease on
`oxy_file_reconciliations` (no run within the last 20 hours, no live lease) and
sends the whole inventory — every (file, case) whose reference is `pending` or
`registered`, streamed in pages — to `OxyServer.assets.references.reconcile('case',
…)`. Oxy adds what it is missing, removes what it holds that the inventory does
not list (only references created before the run began, so nothing registered
during it is undone), and answers `added`, `removed`, `unchanged`, `refused`,
which are logged and stored on the row.

`OXY_FILE_RECONCILIATION` is `apply` (default), `dry_run` (counts only, nothing
changes — the first run on a new deployment can be read before it acts) or `off`.
A failed run is retried at the next hourly check.

## 4. Events: what Oxy says about a file

`POST /webhooks/oxy/file-events` is this service's verified file-events endpoint
(oxy ADR 0043 D9). It is mounted before the JSON parser and outside `/v1`: the
signature over the raw body is the authentication, checked by
`verifyFileEventSignature` from `@oxy.so/core/server` with the secret in
`OXY_FILES_WEBHOOK_SECRET` and a five-minute replay window.

- The unsigned `webhook.challenge` Oxy sends when the endpoint is set is echoed
  (`200 { challenge }`) and nothing else is done with it.
- A signed event is recorded in `oxy_file_events` (Oxy's event id is the key, so
  a redelivery changes nothing and answers `200 { duplicate: true }`), and every
  evidence row of the file — in every tenant, found by the file id rather than
  by the event's references, so a reference still owed is covered — moves to
  what the event says, all in one transaction. A failure answers `500` and Oxy
  delivers again.
- `401` for a signature that does not verify; `503` while no secret is
  configured (the event may be genuine, and Oxy retries); `415` for a body that
  is not JSON.

What an event does to a row:

| Event | File status | Jury |
| --- | --- | --- |
| `file.blocked` | `blocked` | withheld, `file_blocked` |
| `file.trashed` | `trash` | withheld, `file_trashed` |
| `file.deleted` | `deleted` (final; the reference is owed a removal) | withheld, `file_deleted` |
| `file.lost` | `unknown` (the bytes are gone) | withheld, `file_unavailable` |
| `file.unblocked`, `file.restored` | as Oxy states it | shown again when active and not private |
| `file.visibility_changed` | unchanged | withheld while `private` (`file_private`) |

A status this code does not know is recorded as `unknown` and withholds
(`file_unavailable`). An event older than the last one applied changes nothing;
nothing revives a deleted file. Each change to what a jury is shown writes
`evidence.withheld` (with its reason) or `evidence.restored` into the case's
tenant audit trail, with the file id as `subjectId` and no actor.

**Withheld** means the review package keeps the resource with
`retrievable: false` and no `fileId`: the jury learns that material existed and
cannot be shown, and may answer `content_unavailable`, and a reviewer's client
never asks Oxy for bytes that were taken down.

## Configuration and grants

| | |
| --- | --- |
| `OXY_FILES_WEBHOOK_SECRET` | The secret Oxy returns ONCE when the endpoint is set. SSM `/oxy/crowdsource/OXY_FILES_WEBHOOK_SECRET`, named on the task definition. |
| `OXY_FILE_RECONCILIATION` | `apply` (default), `dry_run`, `off`. |
| Oxy scopes of CrowdSource's Oxy application | `files:read` (ownership at ingress) and `files:references:write` (references and reconciliation). Both staff-granted for a `first_party` application. |

Setting the endpoint, in order — the task definition names the parameter, and a
task naming a missing parameter does not start:

1. Create the parameter with a placeholder: `aws ssm put-parameter --name
   /oxy/crowdsource/OXY_FILES_WEBHOOK_SECRET --type SecureString --value unset`.
2. Deploy. Signed events would answer `401` against the placeholder; none is sent
   yet, because no endpoint is set.
3. In the Oxy console (CrowdSource → Webhooks → File events) set
   `https://api.crowdsource.oxy.so/webhooks/oxy/file-events`. The challenge is
   echoed without a secret, and the console shows the secret once.
4. `aws ssm put-parameter --overwrite` it, and force a new deployment. Events Oxy
   tried in between are retried (Oxy backs off to six hours, sixteen attempts).

```docs-claims
entity-type: case
file-events-path: /webhooks/oxy/file-events
file-event-types: file.deleted, file.visibility_changed, file.trashed, file.restored, file.blocked, file.unblocked, file.lost
withheld-reasons: file_trashed, file_blocked, file_deleted, file_private, file_unavailable, file_unreferenceable
reconciliation-modes: apply, dry_run, off
reference-batch-size: 100
reconciliation-min-interval-hours: 20
```
