/**
 * `@oxyhq/crowdsource-app/postgres` — the PostgreSQL half.
 *
 * An adopting application chooses its storage by which subpath it imports, and
 * gets the same moderation pipeline either way. Everything drizzle-shaped lives
 * behind this entry: the three tables this package owns, the columns to spread
 * into your own report table, the two registry fragments to merge into your own
 * gates, and the store the integration is wired with.
 *
 * ```ts
 * import { createModerationIntegration } from '@oxyhq/crowdsource-app';
 * import {
 *   moderationTables,
 *   moderationReportColumns,
 *   moderationReportTableExtras,
 *   postgresModerationStore,
 * } from '@oxyhq/crowdsource-app/postgres';
 * ```
 *
 * `drizzle-orm`, `postgres` and `@oxyhq/db` are OPTIONAL peers, which is what this
 * split buys: a deployment on Mongo never installs them, and a bundler never has
 * to resolve them. Importing this subpath without them fails at the import, by
 * name — which is the failure you want, rather than a driver quietly missing at
 * the first write.
 *
 * **This package ships NO migrations.** It ships table DEFINITIONS; your own
 * `drizzle-kit generate` produces the SQL, in your journal. Two journals against
 * one `drizzle.__drizzle_migrations` table interleave, and the loser is skipped
 * silently with exit 0 — so a migrations folder in a library is a way to lose your
 * migration rather than a convenience.
 *
 * The MODERATION_*_RETENTION_SECONDS windows are NOT here. They are policy both
 * backends share, so they stay on the root entry — and `moderationExpirySweepTargets`
 * is what turns them into deletions, because Postgres has no TTL index.
 */

export { postgresModerationStore } from './store/index.js';
export { postgresTransactionRunner } from './store/transaction.js';
export type { ModerationPgHandle } from './store/transaction.js';

export { moderationTables } from './tables.js';
export type { ModerationTables } from './tables.js';

export {
  moderationReportColumns,
  moderationReportTableExtras,
} from './reportColumns.js';
export type {
  ModerationReportBuiltColumns,
  ModerationReportColumnName,
  ModerationReportColumnOptions,
  ModerationReportColumns,
  ModerationReportTable,
} from './reportColumns.js';

export {
  moderationExpirySweepTargets,
  moderationIdColumnsWithoutForeignKey,
} from './registries.js';
