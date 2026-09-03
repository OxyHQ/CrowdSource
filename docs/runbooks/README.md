# Runbooks

| Runbook | When |
| --- | --- |
| [`webhook-dead-letters.md`](./webhook-dead-letters.md) | A tenant stopped receiving decisions. |
| [`outbox-backlog.md`](./outbox-backlog.md) | Reports are accepted and nothing happens to them. |
| [`case-cannot-empanel.md`](./case-cannot-empanel.md) | Cases sit without a jury. |
| [`audit-trails.md`](./audit-trails.md) | Reconstructing who did what. There are **two** trails. |
| [`crowdsource-app-postgres-cutover.md`](./crowdsource-app-postgres-cutover.md) | Moving an adopter from `@oxyhq/crowdsource-app` 0.6.x to the PostgreSQL-only package. |
| [`crowdsource-backend-postgres-cutover.md`](./crowdsource-backend-postgres-cutover.md) | Moving the CrowdSource service data into its PostgreSQL-only runtime. |

AWS account, region, role and infrastructure facts are **not** duplicated here —
`~/Oxy/oxy-infra` owns them.

## What you are operating

One backend on ECS Fargate at `api.crowdsource.oxy.so`, one PostgreSQL database,
and no queue. Repository state does not prove that the production data cutover
has happened; verify the deployed artifact and task configuration separately.

**There is no BullMQ, no Redis and no SQS in this service.** Both background
loops poll durable PostgreSQL tables directly:

| Loop | Claims from | Started by |
| --- | --- | --- |
| Outbox dispatcher | `outbox_events` | `startOutboxDispatcher()` in `packages/backend/server.ts:77` |
| Webhook delivery | `webhook_deliveries` | `startWebhookDeliveryWorker()` in `packages/backend/server.ts:86` |

Both claim with one atomic PostgreSQL update under a **60-second lease**,
so two tasks are safe and a task that dies mid-handler releases its work when
the lease expires rather than stranding it. Both take the oldest due row first,
so a row backing off on a long rung cannot starve the ones behind it.

The consequence for you: **there is no queue to drain, flush or purge, and no
queue depth to read.** Every question about pending work is a PostgreSQL query
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

**A healthy connection with empty tenant reads is usually missing RLS context.**
Tenant-owned statements must run through `withTenant` or
`withTenantTransaction`, which set and verify both tenant parameters inside one
transaction. Never diagnose this by granting `BYPASSRLS` to the application
role.

**A startup failure after a schema release is usually a migration/provisioning
failure.** Migrations run with the separately provisioned migrator credential;
the application credential owns no tables and remains subject to forced RLS.
Check the migration task and catalogue constraints before restarting application
tasks. Do not apply ad-hoc DDL with the runtime credential.
