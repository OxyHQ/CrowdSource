# `@oxyhq/crowdsource-app`

The application-side CrowdSource integration for PostgreSQL applications. It
stores a report and its outbox event atomically, delivers reports with retries,
verifies signed webhook bodies, applies revisions in order and records reversible
enforcement exactly once.

Version `0.7.0` is PostgreSQL-only. The former `/mongoose` entry point was removed;
the package does not install, import or publish a MongoDB driver. This is a
pre-1.0 breaking release. Upgrade only after the application's own moderation
rows have been migrated and reconciled.

## Install

```sh
bun add @oxyhq/crowdsource-app @oxyhq/crowdsource-contracts \
  @oxyhq/db drizzle-orm postgres express
```

## Schema and store

The adopting application owns its report table. Spread the supplied moderation
columns into that table and use the three package-owned tables for the outbox,
webhook event ledger and enforcement ledger.

```ts
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { DATABASE_CASING } from '@oxyhq/db';
import {
  moderationReportColumns,
  moderationReportTableExtras,
  moderationTables,
  postgresModerationStore,
} from '@oxyhq/crowdsource-app/postgres';

const REPORT_MODERATION = {
  reportedTypes: ['listing', 'review'],
  categories: ['spam', 'harassment'],
} as const;

const reports = pgTable(
  'reports',
  {
    ...moderationReportColumns(REPORT_MODERATION),
    legacyStatus: text('legacy_status'),
  },
  moderationReportTableExtras(REPORT_MODERATION),
);

const moderation = moderationTables({
  enforcementActions: ['restrict', 'restore', 'review', 'none'] as const,
});

const client = postgres(process.env.DATABASE_URL ?? '', { max: 10 });
const db = drizzle(client, {
  casing: DATABASE_CASING,
  schema: { reports, ...moderation },
});

const store = postgresModerationStore({
  db,
  reportTable: reports,
  tables: moderation,
});
```

Generate and apply DDL from the adopter's complete Drizzle schema before the
first write. `store.ensureSchema()` validates the required indexes and checks; it
does not replace migrations.

## Integration

```ts
import express from 'express';
import { createModerationIntegration } from '@oxyhq/crowdsource-app';

const integration = createModerationIntegration({
  store,
  crowdSource: {
    enabled: true,
    serviceKey: process.env.CROWDSOURCE_SERVICE_KEY,
    webhookSecret: process.env.CROWDSOURCE_WEBHOOK_SECRET,
    enforcementMode: 'observe',
  },
  subjects: [listingSubjectProvider(), reviewSubjectProvider()],
  taxonomy: { version: '2026.07', allegationsFor },
  enforcement: commerceEnforcement,
  logger,
});

await store.ensureSchema();

const app = express();
app.use('/webhooks', integration.webhookRouter());
app.use(express.json());
integration.dispatcher.start();
```

Mount the webhook router before `express.json()`: CrowdSource verifies the exact
bytes received. The router refuses a request whose body was already parsed.

## Required guarantees

- Every application-domain mutation and its outbox row use the same Drizzle
  transaction. A pool handle is rejected by the outbox store.
- Delivery and webhook event IDs are idempotency keys. Retrying does not create a
  second row or a second enforcement effect.
- Claims use `FOR UPDATE SKIP LOCKED` and bounded leases, so concurrent workers do
  not process one row twice or wait behind a locked row.
- PostgreSQL does not provide TTL indexes. Schedule sweeps for
  `moderationExpirySweepTargets()` and retain the supplied expiry indexes.
- Never log report content, webhook secrets or provider credentials.

## Migrating from `0.6.x`

Do not upgrade the package first. The repository runbook
[`../../docs/runbooks/crowdsource-app-postgres-cutover.md`](../../docs/runbooks/crowdsource-app-postgres-cutover.md)
defines the fail-closed sequence and evidence manifest. The important boundary
is simple: export with the old application release, import into a separately
named empty PostgreSQL database, reconcile counts and canonical SHA-256 digests,
then deploy the PostgreSQL application release. This package cannot infer an
adopter's custom report collection, primary key or extra columns, so it does not
ship a data copier that guesses them.

## Verification

```sh
bun run --cwd packages/app lint
CROWDSOURCE_APP_TEST_POSTGRES_URL=postgres://... \
  bun run --cwd packages/app test
bun run --cwd packages/app build
bun run check:app-postgres-only
```

The storage behaviour suite runs against PostgreSQL 17, including transaction
rollback, concurrent claims, idempotent enqueue, revision order and enforcement
reversal. The invariant mutation runner removes each load-bearing guard and
requires the named test to fail.
