# Webhook delivery dead-lettered

A tenant has stopped receiving decisions. The unit is the **logical delivery** —
one event to one endpoint, unique on `(webhookEndpointId, eventId)` — and it is
a durable row in `webhook_deliveries`, written before any attempt was made.

## 1. Is it one tenant or all of them?

```
GET /v1/trust-safety/deliveries/dead-letter
```

Trust & Safety, role `security`. Returns up to 100 dead letters across every
tenant, newest first: `deliveryId`, `organizationId`, `applicationId`,
`webhookEndpointId`, `eventId`, `eventType`, `attemptCount`,
`lastResponseStatus`, `deadLetterReason`, `deadLetteredAt`, `replayCount`.

`body` is deliberately absent — it holds the exact signed bytes of the event,
naming a case for a tenant you have no relationship with.

**Several tenants at once is the shape of a fault on our side.** One tenant is
the shape of a fault on theirs. That is the whole point of this endpoint
existing alongside the tenant's own delivery list.

Every read appends a `staff.deadletter.read` row to `staff_audit_events`, and it
is **not** best-effort: if the audit write fails, the read fails. A privileged
surface that quietly serves cross-tenant data when its trail is broken has no
control at all.

## 2. Read the reason before doing anything

`deadLetterReason` (`WEBHOOK_DEAD_LETTER_REASONS`) tells you whether a replay
can possibly work:

| Reason | What happened | Replay helps? |
| --- | --- | --- |
| `attempts_exhausted` | All seven attempts failed transiently. | Yes, once the receiver is back. |
| `client_error` | A 4xx that will not become a 2xx by waiting. Three attempts, not seven. | Only after the receiver is fixed. |
| `endpoint_gone` | The receiver answered `410`. **The endpoint was disabled.** | Not until it is re-registered. |
| `unsafe_target` | The URL resolved into a private or reserved address at delivery time. | **No — investigate first.** |
| `endpoint_disabled` | The endpoint was disabled between fan-out and the attempt. | Only after re-registration. |

`unsafe_target` deserves a stop. The URL passed the offline check at
registration and now resolves into a private or reserved range, which is either
a misconfiguration or a DNS-rebinding attempt. It is terminal rather than
retried precisely so that CrowdSource does not probe an internal address on a
schedule. Do not replay it until you know which of the two it was.

`failureKind` on the individual attempt rows adds the transport-level story:
`http_status`, `unsafe_target`, `upstream_unreachable`, `secret_unavailable`,
`endpoint_disabled`. **`secret_unavailable` is ours, not theirs** — the
endpoint's secret could not be decrypted, meaning a missing or wrong
`WEBHOOK_SECRET_ENCRYPTION_KEY`. Nothing was sent, and the delivery is treated
as transient so it survives until you fix the key.

## 3. The tenant's own view

Developers see their own deliveries without you:

```
GET  /v1/console/applications/{id}/deliveries[?status=dead_letter]
GET  /v1/console/applications/{id}/deliveries/{deliveryId}
POST /v1/console/applications/{id}/deliveries/{deliveryId}/replay
```

Reading needs the `viewer` seat, replay needs `admin`. Point the tenant here
first — a replay is theirs to make and it appends
`console.delivery.replayed` to their own audit trail with the acting member's
Oxy id.

The attempt history carries a bounded, redacted preview of the failure response,
which is the field an integrator debugs a rejected signature with. **A success
keeps nothing**, and no preview ever reaches a log at any level.

## 4. Replay

Replay puts the row back to `pending` with `nextAttemptAt` now.

- The **attempt counter keeps climbing**, so attempt numbers stay unique and the
  whole history stays readable.
- The **cycle counter resets**, so the ladder starts again from thirty seconds.
  A replay after the cause was fixed gets the same patience the first delivery
  had.
- `replayCount` increments — a delivery replayed repeatedly is a receiver nobody
  actually fixed.

Only a `dead_letter` delivery can be replayed; anything else is `409`.

**There is no cross-tenant bulk replay route.** After a fault on our side you
either ask each affected tenant to replay from their console, or you re-run the
fan-out over the outbox rows, which reconstructs the same
`(endpoint, event)` pairs — the unique index refuses any that already exist, so
that is safe.

## 5. When the receiver was fine and we still failed

Two causes produce dead letters that are not the receiver's fault, and both are
fixed here:

- **`WEBHOOK_SECRET_ENCRYPTION_KEY` missing or rotated wrongly.** Symptom:
  `failureKind: 'secret_unavailable'` across many endpoints at once, plus `503`
  from `POST /v1/webhook-endpoints` naming the variable. Restore the key; the
  deliveries are still `pending` and will go out.
- **A rotation cutover with no overlap.** `rotateSecret` with
  `overlapSeconds: 0` is an immediate cutover, correct for a leak and wrong for
  a routine rotation. A receiver that had not installed the new secret refuses
  every delivery with a signature mismatch — which surfaces as `client_error`
  dead letters within twenty minutes, not as a signature error anybody sees.
  Tell the tenant to set `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS` during the
  overlap.

## What the alert is today

`recordAttempt` logs `'Webhook delivery dead-lettered'` at `warn` with ids, the
attempt count, the classification and the response status — no body, no preview,
no URL. **That log line is the entire alerting mechanism.** The tenant-facing
alert the plan asks for needs a notification channel CrowdSource does not have,
so the durable `dead_letter` row plus this runbook stands in for it. If nobody
is watching that log, nobody is watching dead letters.

Per-endpoint health is four counts, not a ratio — `pending`, `delivering`,
`succeeded`, `deadLetter` — because a ratio hides the case that actually
matters: a healthy-looking success rate next to a growing dead-letter queue.

## One number that is wrong in the plan

The plan's SLO is "99.9% of events delivered or visible in the DLQ within 24
hours", and the ladder only reaches its **last** attempt at 24 hours — so a
delivery that fails all seven becomes visible as a dead letter at roughly 32.5
hours. The schedule is the more specific statement and the one an integrator can
observe, so it wins; the SLO is the number that needs revising. Do not treat a
dead letter appearing at hour 30 as a breach.
