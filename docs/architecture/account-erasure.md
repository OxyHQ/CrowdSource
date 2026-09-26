# Account erasure

When a person deletes their Oxy account, CrowdSource erases or anonymises what it
holds under their id. This page is the trigger, the guarantees, the decision for
every place the id can be, and how to verify a run. Origin:
[OxyHQ/Mention#1178](https://github.com/OxyHQ/Mention/issues/1178), following
Mention's own erasure (OxyHQ/Mention#1169). Oxy's side of the contract is oxy
`docs/identity/account-events.md`.

The code is `packages/backend/src/modules/accountErasure/`, with the statements
in `db/postgres/repositories/accountErasure.ts` (unscoped tables) and
`db/postgres/repositories/scoped/accountErasure.ts` (tenant tables).

## Trigger: push and pull, signed events only

Oxy's `DELETE /users/me` writes a signed `account.deleted` Security Event Token
for every first-party application, CrowdSource included (its Oxy application is
`first_party` in oxy's application seed), in the transaction that deletes or
archives the account. CrowdSource erases on either outcome; `retained` is only
recorded.

- **Push.** `POST https://api.crowdsource.oxy.so/webhooks/oxy/account-events`
  (`Content-Type: application/secevent+jwt`), declared as the application's
  `webhookUrl` in oxy's application seed. The route verifies the token with
  `@oxy.so/core`'s `verifyAccountEvent` (signature against Oxy's JWKS, `typ`,
  issuer, audience = CrowdSource's Oxy application), records the event and
  answers `202`. A token that does not verify is `401`; a body that is not a
  compact JWS `400`; another content type `415`; a token that could not be
  CHECKED (key set unreachable, no service identity) `503`, so Oxy retries; a
  failure to record `500`. It mounts before the JSON parser and outside `/v1`:
  the token is the authentication, so neither a service credential nor an Oxy
  session is a caller class of this route. 16 KB body limit; a per-address rate
  limit (600/minute, keyed on a digest of the address, in memory).
- **Pull.** Every task runs a timer (`accountEventReconciliation.ts`, every 5
  minutes, first pass 30 s after boot) that reads `GET /account-events` forward
  from the cursor in `account_event_cursors`, verifies every token again and
  records each event. There is no leader election in this service, so the feed
  is read under a lease on the cursor row, and the cursor moves only while that
  lease is held and only past a page whose every event was recorded. A token the
  feed serves that does not verify is skipped (it never will); any other failure
  leaves the cursor where it was.

The service's Oxy identity is the task's attested IAM role (oxy ADR 0026); an
`OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` pair, if the task ever carries
one, is used instead. Both the audience check and the pull feed follow that
identity.

**Nothing infers a deletion.** A missing profile or a `404` from Oxy starts
nothing. Only a verified event does.

## Idempotency and durability

`account_erasures` is the ledger and the durable work record: one row per event,
keyed on Oxy's event id (`jti`). It commits before the webhook answers `202`. A
redelivered event, or the same event by push and by pull, finds the existing
row. A run takes a lease on the row (10 minutes), so one account is never erased
by two tasks at once; a failure leaves the row `failed` with a CLASS in
`last_error` (a SQLSTATE or an error name, never a message), and the
reconciliation tick retries every unfinished row whose lease is free. Every step
matches by the person's id and leaves nothing that still matches, so a re-run
converges and a run for an unknown account is a no-op. Runs log start and end
with per-category counts, and store the same counts on the row. The id is never
logged.

The ledger keeps the Oxy id after completion: it is the proof the erasure ran,
and nothing else in the database carries the id any more.

## Where the id is matched

As an **Oxy account**: reviewer profiles, console memberships and staff rows, the
operator trail and the tenant audit trail.

As an **application principal**, in every tenant: any principal id equal to the
Oxy id. That covers an `oxy_user` binding (whose `bindingProofId` is the Oxy
subject) and any application that chose the Oxy id as its principal id — Mention
does, for reports and community notes. An application whose principal ids are
its own opaque ids has no matching row, so nothing of its users is touched. The
only way another person's row could match is a tenant giving that person the
deleted account's exact Oxy id as their principal id, which makes them the same
person.

The tenant tables are read under `withTenant`, one application at a time, with
the context built from the stored `applications` row — the same way the outbox
workers enter a tenant from a stored row. No tenant is named by a caller, and
row security holds for every statement.

## What is deleted

- **The person's community notes**, with the ratings others gave them, the
  assignments to rate them and their status history. A note is the writer's
  own words. A reader app may show a cached note for up to its cache lifetime
  (Mention: 5 minutes); no status webhook is sent for a deleted note.
- **The person's ratings** of other notes, and their open rating assignments.
  A later rescoring runs without them; the recorded status revisions keep the
  counts they were computed from.
- **Console access**: organization memberships and Trust & Safety staff roles.
  An organization whose only owner was the person is left without an owner, and
  staff restore one through the console.
- **Reviewer data about the person**: the application accounts they linked as
  theirs, the conflicts they declared, their co-service pairs, and the free-text
  notes on their reviews. Other reviewers' declared conflicts WITH the person's
  account are deleted too; they only kept a reviewer off cases involving an
  account that no longer exists.

## What is kept, and why

| Kept | Form | Why |
| --- | --- | --- |
| Reports the person filed | Their binding's `externalPrincipalId` and `bindingProofId` replaced by `erased-account`; their `details` removed from their allegations | A report is a moderation record: the case, its decision and any appeal rest on it (GDPR Art. 17(3)(e); DSA record-keeping). The allegation CODE is the claim the case was opened on. |
| Reports and cases ABOUT the person's material | Their binding and the snapshot's principal replaced by `erased-account`; the material unchanged | The material is the evidence a decision rests on, and a published decision is never edited. The link from it to the person goes. |
| Each case's reporter set | The person's fingerprint replaced by a stand-in | Triage counts distinct reporters; the count stays right and no value in the set is derivable from the id. |
| Community notes others wrote about the person's material | `subject_author_principal_id` replaced by `erased-account` | Other people's words. The id only served "an author never rates a note on their own post". |
| Appeals the person filed | Appellant replaced by `erased-account`, `author_context` removed | A moderation record; the statement is the person's own words. |
| The reviewer profile | Oxy id replaced by `erased-<reviewer id>`; `account_active` and `available` false; languages, categories, consents, declared conflicts and training cleared | Reviews and draws name the reviewer id, and a case still being counted reads the profile's state and specialisms to count a ballot already cast. It can never be drawn again. |
| The person's reviews and draw records | Unchanged, notes cleared | A vote is part of a published decision's explanation; with the profile detached it is a pseudonymous vote. |
| Their open review seats | Made due now | The ordinary expiry sweep closes each and draws a replacement, so no panel is left a juror short. |
| The operator trail, the tenant audit trail, standing changes, invitations sent | Actor replaced by `erased-account` | Accountability for privileged acts outlives the operator; the act stays, the person goes. |
| Webhook bodies naming the person as a note writer | `data.authorPrincipalId` replaced by `erased-account` | Bodies are signed when sent, so a pending delivery still verifies. |

**Pseudonymisation, not anonymity, for the principal refs.** A binding's
`principalRef` is a truncated SHA-256 of the principal type and id, and it is
referenced from published decisions, which are never edited. Once the binding
is erased nothing in this database maps a ref back to the person, but someone
who already holds the Oxy id could recompute it and find the retained records.
The same holds for the reports' `payload_hash` and the cases' `content_hash`,
which are digests over what was delivered. These records are kept for the
reasons in the table, not claimed to be anonymous.

## Not covered yet

- **Case retention.** `cases.retention_days` is recorded but nothing sweeps a
  case, so the retained moderation records above have no end date. That is a
  gap of the retention model, not of erasure, and it is where their eventual
  deletion belongs.
- **`webhook_attempts`** hold a tenant server's redacted response bodies and
  are swept after 90 days (`db/postgres/expiry.ts`); erasure does not read them.
- **Uploaded evidence** is Oxy media (`cloud.oxy.so`), erased by Oxy's account
  deletion rather than here.

## Verifying a run

For an Oxy id `U` and event id `E`:

1. `select status, attempts, completed_at, counts, last_error from account_erasures where event_id = 'E';`
   is `completed`.
2. `packages/backend/src/__tests__/accountErasure.integration.test.ts` seeds one
   person into every place above and asserts that afterwards no row in any table
   but the ledger contains the id, read table by table and tenant by tenant.
   A new place the id can land is added to that seed, and the sweep then fails
   until erasure decides what happens there.
