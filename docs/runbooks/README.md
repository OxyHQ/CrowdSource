# Runbooks

| Runbook | When |
| --- | --- |
| [`webhook-dead-letters.md`](./webhook-dead-letters.md) | A tenant stopped receiving decisions. |
| [`outbox-backlog.md`](./outbox-backlog.md) | Reports are accepted and nothing happens to them. |
| [`case-cannot-empanel.md`](./case-cannot-empanel.md) | Cases sit without a jury. |
| [`audit-trails.md`](./audit-trails.md) | Reconstructing who did what. There are **two** trails. |

AWS account, region, role and infrastructure facts are **not** duplicated here —
`~/Oxy/oxy-infra` owns them.

## What you are operating

One backend on ECS Fargate at `api.crowdsource.oxy.so`, one MongoDB database,
and no queue. Read that last part carefully, because it changes every procedure
below.

**There is no BullMQ, no Redis and no SQS in this service.** Both background
loops poll MongoDB directly:

| Loop | Claims from | Started by |
| --- | --- | --- |
| Outbox dispatcher | `outbox_events` | `startOutboxDispatcher()` in `packages/backend/server.ts:77` |
| Webhook delivery | `webhook_deliveries` | `startWebhookDeliveryWorker()` in `packages/backend/server.ts:86` |

Both claim with a single atomic `findOneAndUpdate` under a **60-second lease**,
so two tasks are safe and a task that dies mid-handler releases its work when
the lease expires rather than stranding it. Both take the oldest due row first,
so a row backing off on a long rung cannot starve the ones behind it.

The consequence for you: **there is no queue to drain, flush or purge, and no
queue depth to read.** Every question about pending work is a MongoDB query
against a durable row, and every "replay" is a state change on that row. A
restart loses nothing.

## The two health endpoints

| | |
| --- | --- |
| `GET /health/live` | The process is running. |
| `GET /health/ready` | The load balancer may send traffic — `503` while starting, draining, or with the database down. |

Readiness re-reads the connection state on every request rather than caching a
boot-time result, so a database that drops later is reflected immediately. There
is no `GET /health`; it answers `404`.

## Before you start: two failures that look like something else

**A crash loop right after a database change is probably the topology
assertion.** A domain write and its outbox row commit in one MongoDB
transaction, and transactions require a replica set.
`src/utils/mongoTopology.ts` asserts this at boot and **refuses to start on a
standalone**, by design — the alternative is discovering it at the first
transactional write.

```bash
mongosh --eval 'rs.status().set'
```

**Silent duplicates are probably missing indexes.** Index creation is
application code (`ensureIndexes` in `src/db/collections.ts`), not a schema
migration, and a deployment whose indexes were never built accepts duplicate
reports, duplicate reviews and duplicate reputation effects **while reporting
perfect health**. `createIndexes` is used rather than `syncIndexes` because the
latter also drops anything absent from the current schema, which on a rolling
deploy means the previous task version loses an index the new one has not
finished building.

`RUN_MIGRATIONS` is `false` and the migration runner does not exist. Do not flip
it ahead of the runner. There is no staging deployment, so a destructive change
is exercised for the first time against real cases — plan accordingly.
