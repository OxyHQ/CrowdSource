# Webhooks

A decision reaches an application over a webhook, not by polling. Register an
endpoint with
[`POST /v1/webhook-endpoints`](./application.md#post-v1webhook-endpoints) and
receive with `@oxyhq/crowdsource-express`, which implements everything below so
none of it can be got wrong by mounting things in the wrong order.

## The envelope

```json
{ "id": "…", "type": "case.decided", "createdAt": "2026-07-30T00:00:00.000Z",
  "organizationId": "…", "applicationId": "…", "data": { } }
```

Serialised as **canonical JSON — sorted keys** — so the same event produces the
same bytes on every process and every retry. Receivers parse JSON and do not
care about key order; CrowdSource does, because the signature covers these
bytes.

`id` is the idempotency key. It is the **outbox row's id**, reused all the way
through: replaying the outbox row produces the same `(endpoint, event)` pair,
the unique index refuses the second insert, and your dedupe keys on the same
string you already saw. Store it.

Every payload is a *loose* schema. An unknown field is a newer server, not an
attack; keep it if you persist `event.data`.

## Event catalogue

Eight types are defined (`WEBHOOK_EVENT_TYPES` in
`@oxyhq/crowdsource-contracts`). **Five are wired and three are not**, and the
difference matters when you decide what to subscribe to. Registration rejects a
type outside those eight (`assertKnownEventTypes` in
`modules/webhooks/endpoint.service.ts`) but accepts the three unwired ones — so
subscribing to one of those is silently a subscription to nothing.

| Type | `data` | Wired |
| --- | --- | --- |
| `report.received` | `{ reportId, caseId, status, merged }` | yes |
| `case.decided` | `{ caseId, decision }` | yes |
| `decision.corrected` | `{ caseId, decision }` (must supersede) | yes |
| `appeal.created` | `{ caseId, appealId }` | yes |
| `appeal.decided` | `{ caseId, appealId, decision }` | yes |
| `case.created` | `{ caseId }` | **no** |
| `case.escalated` | `{ caseId }` | **no** |
| `case.closed` | `{ caseId }` | **no** |

What is wired is `WEBHOOK_EVENT_SOURCES` in
`packages/backend/src/modules/webhooks/fanout.ts`. `case.closed` waits on
retention and closure. `case.created` and `case.escalated` are observable inside
ingestion and triage but are not published to the outbox.

`case.decided` and `decision.corrected` carry the same object; what differs is
what you are being told. The first is "here is the outcome"; the second is "the
outcome you were told before has been replaced", and a correction has its own
consequences — reverting a conduct effect, asking you to restore — so an
application must be able to subscribe to it separately.

`appeal.decided` is **not** the same as `decision.corrected`. An appeal that
upheld the original decision has still produced a result the appellant is owed;
only one that changed the outcome is a correction.

The decision in a payload is the DTO. `agreeingReviewerIds` never leaves the
database — juror identities are withheld from the jury itself, and an
application learning which reviewers decided against its user would be worse.

## Signature

```
signedPayload = timestamp + "." + rawBody
signature     = HMAC_SHA256(secret, signedPayload)
header        = "v1=" + hex(signature)
```

| Header | |
| --- | --- |
| `X-CrowdSource-Event-Id` | The envelope's `id`. |
| `X-CrowdSource-Timestamp` | Unix **seconds**, as a string. |
| `X-CrowdSource-Signature` | `v1=<64 lowercase hex>`. |

HTTP header names are case-insensitive; look them up accordingly.

Three properties, and each of them is a way receivers get this wrong:

1. **The signature covers the RAW body.** A body that was parsed and
   re-serialised is different bytes and does not verify. That is the point of
   signing raw bytes: it stops a receiver validating one document and acting on
   another.
2. **The timestamp is the header value verbatim.** Re-deriving it from a parsed
   number is the mistake the signature exists to catch.
3. **Comparison is constant time.** Never `!==`.

`buildWebhookSignedPayload(timestamp, rawBody)` is exported by
`@oxyhq/crowdsource-contracts` and is the only thing sender and receiver share.
A sender and a receiver that each decide for themselves what gets signed agree
right up until they do not.

**Freshness: ±300 seconds, in both directions**
(`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`). A past timestamp outside the window is
a replay; a future one is either a clock you do not control or an attacker
choosing a timestamp to keep a captured signature alive longer.

**During a rotation both secrets are accepted.** A receiver holding the outgoing
and the incoming secret accepts either, which is what makes the cutover
invisible to it.

## Retry

`WEBHOOK_RETRY_SCHEDULE_SECONDS` — the delay before each attempt after the
previous one failed. Seven attempts in total: the initial one plus one per rung.

| After attempt | Wait |
| --- | --- |
| 1 | 30 s |
| 2 | 2 min |
| 3 | 15 min |
| 4 | 1 h |
| 5 | 6 h |
| 6 | 24 h |

No jitter, deliberately: the ladder is an exact sequence a caller can read and a
test can assert. What bounds a thundering herd is that the ladder is relative to
each delivery's own first attempt, not to a wall clock.

**A classified client error gets three attempts, not seven**
(`WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS`). A 400, a 401 or a 404 says the request as
we send it will not be accepted, and grinding through 32 hours of that helps
nobody — but a receiver can also answer 404 for the five minutes a bad build is
live, so three attempts spans the first three rungs. A permanent
misconfiguration dead-letters within twenty minutes instead of a day and a half.

`408` and `429` are 4xx by number and transient by meaning, so they take the
full ladder. `410` is terminal and **disables the endpoint**.

A `Retry-After` can only ever push the next attempt **later**, and is ignored
past 24 hours. Honouring a shorter one would let a receiver under load ask us to
come back in a second.

After the last attempt the delivery is `dead_letter`, and replay is manual —
[the runbook](../runbooks/webhook-dead-letters.md).

## What a receiver must do

- **Answer `2xx` quickly and queue the processing.** The delivery is retried on
  the ladder above if you are slow.
- **Refuse a bad signature with a non-2xx.** A refused delivery stays on the
  sender's retry schedule; a `2xx` retires it as processed.
- **Deduplicate on `event.id`**, and make your enforcement idempotent anyway.
- **Acknowledge and ignore an event type you do not handle.**

`@oxyhq/crowdsource-express` does all of that, including reading the request
stream itself and **refusing** rather than reconstructing bytes when something
upstream already consumed the body. The likeliest way to ship a broken receiver
is to verify a signature over `JSON.stringify(req.body)`: it passes every
payload a developer writes by hand and fails on the first real delivery whose
formatting differs — or worse, accepts a forged body that happens to
re-serialise identically.

Its default deduplication store is in-process, so two instances behind a load
balancer each keep their own. Pass a shared `store` implementing
`claim`/`release` if your enforcement is not idempotent.

## The half of a webhook test that proves something

`@oxyhq/crowdsource-testing`'s `WebhookSimulator` delivers genuinely signed
events, and can deliver stale, forged and tampered ones on purpose:

```ts
await simulator.deliver(caseDecidedEventFixture());                        // 200
await simulator.deliver(caseDecidedEventFixture(), { expired: true });     // must be refused
await simulator.deliver(caseDecidedEventFixture(), { wrongSecret: 'x' });  // must be refused
await simulator.deliver(caseDecidedEventFixture(), { tamperedBody: '…' }); // must be refused
```

A suite that only ever sends valid deliveries proves the receiver can say yes.
