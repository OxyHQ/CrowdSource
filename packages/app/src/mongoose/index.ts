/**
 * `@oxyhq/crowdsource-app/mongoose` — the MongoDB half.
 *
 * An adopting application chooses its storage by which subpath it imports, and
 * gets the same moderation pipeline either way. Everything Mongoose-shaped lives
 * behind this entry: the schema fields to compose into your own report model,
 * the indexes those queries depend on, the three collections this package owns,
 * and the store the integration is wired with.
 *
 * ```ts
 * import { mongooseModerationStore, moderationReportSchemaFields } from
 *   '@oxyhq/crowdsource-app/mongoose';
 * ```
 *
 * `mongoose` is an OPTIONAL peer dependency, which is what this split buys: a
 * deployment on the other backend never installs it, and a bundler never has to
 * resolve it. Importing this subpath without `mongoose` present fails at the
 * import, immediately and by name — which is the failure you want, rather than a
 * driver quietly missing at the first write.
 *
 * The MODERATION_*_RETENTION_SECONDS windows are NOT here. They are policy both
 * backends share, so they stay on the root entry.
 */

export { mongooseModerationStore } from './store/index.js';

export {
  moderationReportSchemaFields,
  applyModerationReportIndexes,
  MODERATION_LOCAL_STATUSES,
} from './report.js';
export type { ModerationReportSchemaOptions } from './report.js';

export {
  MODERATION_ENFORCEMENT_COLLECTION,
  MODERATION_EVENT_COLLECTION,
  MODERATION_OUTBOX_COLLECTION,
} from './models.js';
export type {
  ModerationEnforcementDocument,
  ModerationEventDocument,
  ModerationEventState,
  ModerationModels,
  ModerationOutboxDocument,
} from './models.js';
