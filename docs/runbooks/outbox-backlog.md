# The outbox is backing up

Reports are accepted, `202` comes back, and nothing happens to them: no case
moves, no panel is drawn, no decision is delivered.

## What the outbox is, and why a backlog is survivable

Every domain write commits **in one PostgreSQL transaction with its outbox row**.
`appendOutboxEvent` requires a `PgTransactionHandle` and verifies it at runtime,
so the ordinary path cannot write an event outside the transaction or separate
it from the object it describes.

The dispatcher then reads those rows. **The row is the record; nothing is ever
enqueued anywhere else.** That is what makes a backlog a delay rather than a
loss: every pending piece of work is re-derivable by re-reading
`outbox_events`.

An outbox payload carries **references only** — `reportId`, `caseId`,
`assignmentId`, `decisionId`, `appealId`. Never reported content, because an
outbox payload gets copied into logs, metrics and attestations by the time a
delivery has been retried a few times.

## 1. Look at the row states

`outbox_events.status` is one of `pending`, `dispatching`, `dispatched`,
`failed`.

```sql
SELECT status, type, count(*) AS n,
       min(available_at) AS oldest_available_at,
       max(available_at) AS newest_available_at
FROM outbox_events
GROUP BY status, type
ORDER BY status, type;
```

| What you see | What it means |
| --- | --- |
| Many `pending`, all of one `type` | That type has **no registered consumer** in this process. |
| Many `pending`, mixed types, `availableAt` in the past | The dispatcher is not running. |
| Many `dispatching` with `availableAt` in the past | A task died mid-handler. The lease expires and they are reclaimed automatically. |
| Growing `failed` | Dead letters. Go to step 3. |
| Many `pending` with `availableAt` in the future | Backoff. Read `lastError`. |

`dispatching` is a **lease, not a state a consumer reports**. The dispatcher
stamps it with a 60-second expiry, and an expired one is claimable again — that
is crash recovery, and without it a process that died mid-handler would hold its
events forever.

## 2. `pending` forever, all of one type

**A type with no registered consumer is never claimed at all.** That is
deliberate and it is the property the outbox exists for: an event nobody
consumes yet stays `pending` rather than being marked dispatched by a loop that
did nothing with it. Marking it would destroy the guarantee that pending work is
re-derivable.

The cost is a backlog a new consumer meets on its first run, which is the
correct direction — a consumer arriving to find work waiting can act on it; one
arriving to find the work already marked done has no way to know anything was
lost.

Consumers are wired in one place, `modules/outbox/workers.ts`: triage,
sortition (two handlers), consensus, and the webhook fan-out. The fan-out
registers itself for every internal event it translates, so a module that
publishes an event never has to know webhooks exist.

`registeredOutboxEventTypes()` answers "which consumers did this process wire
up?" without running a pass — which matters, because running a pass against a
shared database is exactly what you must not do while diagnosing.

## 3. `failed` rows are dead letters, and they are kept

A row that exhausts **8 attempts** (`OUTBOX_MAX_ATTEMPTS`) becomes `failed`. It
is **not deleted**, deliberately: discarding it would turn a handler bug into
permanently lost moderation work. Backoff between attempts is exponential from
2 seconds, capped at 15 minutes.

`lastError` holds the failure **message only, truncated to 500 characters** —
never a stack, never the document. An outbox handler works with reported
material, and a driver error routinely quotes what it choked on.

To replay after fixing the cause, use one reviewed event type and inspect the
exact returned ids. Do not run an unbounded update:

```sql
BEGIN;

UPDATE outbox_events
SET status = 'pending',
    attempts = 0,
    available_at = now(),
    last_error = NULL,
    updated_at = now()
WHERE status = 'failed'
  AND type = '<reviewed event type>'
RETURNING event_id, organization_id, application_id, type;

-- Commit only after the returned rows match the approved incident scope.
COMMIT;
```

Every handler is idempotent — it has to be, because at-least-once delivery is
the contract — so replaying one that partly succeeded is safe. The domain
absorbs it through the same unique indexes idempotency rests on everywhere else.

**There is no HTTP route for outbox replay**, for any caller class. This is a
database operation.

## 4. The dispatcher is not running

It is started by `server.ts`, never by `app.ts` — building the HTTP application
must not start a timer. It polls every second and drains up to 25 rows per pass.
The interval timer is `.unref()`'d, so it never holds a shutdown open.

If `/health/ready` answers `200` and rows are due and untouched, the process is
serving HTTP with its dispatcher stopped. Restart the task. Nothing is lost by
restarting: the leases expire and the rows are reclaimed.

## 5. The failure the outbox cannot protect you from

**Work enqueued without its outbox row is lost moderation work with no trace.**
Nothing in the infrastructure enforces the rule — `appendOutboxEvent` requiring
a transaction is as close as it gets, and it only enforces the transaction, not the
decision to write a row at all. The rule holds by review.

If a module ever calls another module's service directly across the outbox
boundary, the symptom is not an error. It is a domain object that exists with no
record that anything should happen next, discovered the day somebody asks why a
case never got a panel.

## What is deliberately absent

- **No queue.** No BullMQ, no `REDIS_URL`, no `bullmq` dependency. If one is
  added later, it must carry an explicit non-zero database index on the shared
  Valkey, or two Oxy backends elect one leader between them and consume each
  other's jobs — and it would be a latency optimisation over this loop, never a
  correctness component.
- **No retention or closure job.** `case.closed` is defined as a webhook event
  and nothing publishes it. Cases do not currently expire, and neither does
  evidence.
- **No `Incident` table.** `cases.incident_id` is currently `null` on rows created
  by `modules/cases/case.service.ts`, so cross-tenant
  correlation of one piece of material across applications **does not exist**.
  The reputation-effect index that would be built on it has nothing to be built
  on.

## Machine-checked claims

```docs-claims
outbox-statuses: pending, dispatching, dispatched, failed
outbox-max-attempts: 8
outbox-lease-ms: 60000
outbox-event-types: report.received, case.ready_for_triage, case.ready_for_review, assignment.vacated, review.submitted, case.decided, decision.corrected, appeal.created, appeal.decided
no-incident-module: true
no-queue-dependency: true
```
