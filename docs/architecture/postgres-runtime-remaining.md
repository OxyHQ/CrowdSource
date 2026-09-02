# PostgreSQL runtime cut: remaining service work

This is the completion boundary for `@crowdsource/backend`, not a production
claim. The application package is PostgreSQL-only; the service is not.

Measured from the source tree on 2026-09-02:

- 26 Mongoose-backed collection declarations remain;
- 30 non-test backend files import Mongoose;
- `packages/backend` still depends on `mongoose` at runtime and
  `mongodb-memory-server` for its integration suite;
- boot still connects to both databases and requires `MONGODB_URI`;
- service transactions, index creation, readiness and dispatcher claims still
  use the MongoDB driver;
- no source database was inspected or modified by this phase.

## Remaining collections

| Domain | Collections |
| --- | --- |
| Tenancy and console | `organizations`, `applications`, `applicationCredentials`, `organizationMembers`, `trustSafetyStaff`, `staffAuditEvents` |
| Intake and governance | `reports`, `cases`, `caseReports`, `policySets`, `auditEvents`, `usageCounters` |
| Jury and decisions | `reviewerProfiles`, `reviewerRelations`, `reviewerAffinities`, `assignments`, `sortitionDraws`, `reviews`, `decisions`, `appeals` |
| Delivery and trust | `outboxEvents`, `applicationTrust`, `webhookEndpoints`, `webhookSecrets`, `webhookDeliveries`, `webhookAttempts` |

## Completion gates

The service is PostgreSQL-only only when all of these are true in one reviewed
cutover:

1. Every call site above uses the existing Drizzle repositories under the
   correct RLS-scoped transaction; domain write and outbox append share the same
   handle.
2. Source export and target re-export reconcile exact IDs, row counts and
   canonical SHA-256 digests for every collection/table mapping. The importer
   refuses a non-empty target and unknown fields.
3. Boot, readiness, transactions, dispatchers and webhook workers have no Mongo
   connection or topology path.
4. Runtime package, lockfile ownership, Docker image, CI cache, environment
   schema and deploy wiring contain no MongoDB driver or `MONGODB_URI`.
5. Real PostgreSQL tests cover tenant isolation, concurrent deduplication,
   immutable decisions, claims, retries and rollback/outbox atomicity.
6. The global anti-Mongo gate has positive controls and scans runtime, deploy,
   manifests and dependency ownership. The app-only gate in this phase is not a
   substitute.
7. The exact production target, migration task definition and deployed artifact
   are verified separately. This repository phase performs none of those
   production actions.

The expanded `cases` schema and `upsertCaseForReport` are preparation for item 1.
Migration `0008` refuses a populated partial PostgreSQL `cases` table before it
drops the old, incorrect two-column unique index; it does not backfill or invent
values.
