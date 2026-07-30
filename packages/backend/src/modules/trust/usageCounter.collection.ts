import { Schema, type ClientSession } from 'mongoose';

import { defineTenantCollection } from '../../db/collections';
import type { TenantContext } from '../../db/tenantScope';

/**
 * Usage metering (§15.10: "cuotas, usage metering y billing hooks"; §16.4's
 * `reports_received_total` "por aplicación").
 *
 * One document per application per UTC day, incremented inside the ingestion
 * transaction. It exists because a quota needs an O(1) answer to "how many today":
 * counting the `reports` collection per request means an index scan proportional to
 * the day's volume on the hot path, which is the wrong cost at the exact moment a
 * tenant is sending most.
 *
 * **The increment shares the report's transaction, and that is the whole design.**
 * Not for the counter's sake — a slightly low count is survivable — but because a
 * counter incremented outside it would be incremented for reports that then rolled
 * back, and a tenant would be rate-limited for deliveries that were never stored.
 * A retry of the same delivery aborts before reaching this line, so a replayed
 * report is not counted twice.
 */

export interface UsageCounterDocument extends TenantContext {
  /** The UTC day as `YYYY-MM-DD`. See `utcDayKey` for why a string. */
  day: string;
  reportsReceived: number;
  createdAt: Date;
  updatedAt: Date;
}

const usageCounterSchema = new Schema<UsageCounterDocument>(
  {
    organizationId: { type: String, required: true },
    applicationId: { type: String, required: true },
    day: { type: String, required: true },
    reportsReceived: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, collection: 'usage_counters' },
);

/**
 * One row per application per day, and the reason it is unique rather than merely
 * indexed: the write is an upsert, and two concurrent first reports of the day
 * would otherwise both insert, leaving two rows whose counts each understate the
 * truth and a quota check that reads whichever it finds.
 */
usageCounterSchema.index({ applicationId: 1, day: 1 }, { unique: true });

export const usageCounters = defineTenantCollection('UsageCounter', usageCounterSchema);

/**
 * The day key, in UTC.
 *
 * A string and not a `Date` truncated to midnight, because the value is a KEY: a
 * `Date` invites a timezone-dependent truncation somewhere down the line, and the
 * day two callers computed differently is a day whose count is split across two
 * rows. UTC and not the tenant's locale because a quota measured in a moving
 * window is a quota nobody can reconcile against an invoice.
 */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Counts one accepted report, inside the transaction that stored it.
 *
 * `session` is REQUIRED, unlike the audit trail's, and the difference is
 * deliberate: an audit row for a refusal has no transaction to join, while there
 * is no such thing as a report counted outside the transaction that accepted it.
 */
export async function recordReportUsage(
  context: TenantContext,
  session: ClientSession,
  at: Date,
): Promise<void> {
  /**
   * `updatedAt` goes in `set` and `createdAt` in `setOnInsert`, matching the operators
   * Mongoose's own `timestamps` plugin uses. Putting `updatedAt` in `setOnInsert`
   * instead makes MongoDB reject the whole update with `ConflictingUpdateOperators` —
   * the same path cannot be written by two operators in one document.
   */
  await usageCounters.upsertOne(
    context,
    { day: utcDayKey(at) },
    { inc: { reportsReceived: 1 }, set: { updatedAt: at }, setOnInsert: { createdAt: at } },
    session,
  );
}

/** How many reports this tenant has had accepted on the given UTC day. */
export async function reportsReceivedOn(context: TenantContext, at: Date): Promise<number> {
  const counter = await usageCounters.findOne(context, { day: utcDayKey(at) });
  return counter?.reportsReceived ?? 0;
}

/**
 * The per-day counts across a window, newest day first.
 *
 * Bounded by `days` rather than paginated: the console's usage view asks about a
 * window an operator chose, and an unbounded read of a collection that grows one
 * row per day forever is the kind of query that is fine for a year and then is not.
 */
export async function reportUsageWindow(
  context: TenantContext,
  days: number,
  now: Date,
): Promise<readonly UsageCounterDocument[]> {
  const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return usageCounters.find(
    context,
    { day: { $gte: utcDayKey(from), $lte: utcDayKey(now) } },
    { sort: { day: -1 }, limit: days },
  );
}
