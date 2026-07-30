import type { TenantContext } from '../../db/tenantScope';
import { auditEvents, type AuditEventDocument } from '../audit/audit.collection';
import { cases } from '../cases/case.collection';
import { decisions } from '../decision/decision.collection';
import { quotaForApplication } from '../trust/applicationTrust.service';
import type { ApplicationQuota } from '../trust/quota';
import { reportUsageWindow } from '../trust/usageCounter.collection';
import { deliveryHealthFor, type DeliveryHealth } from '../webhooks/delivery.service';
import { webhookEndpoints, type WebhookEndpointDocument } from '../webhooks/webhook.collections';

/**
 * The operational views of the developer console (§4.2's usage, quotas and webhook
 * health; §16.4's per-application metrics).
 *
 * Every read here takes a `TenantContext` that a membership check produced. Nothing
 * in this file can be called without one, which is what keeps a developer surface
 * from becoming an accidental cross-tenant one — a count is still another tenant's
 * data.
 */

/** How many days a usage window may cover. */
export const MAX_USAGE_WINDOW_DAYS = 90;
export const DEFAULT_USAGE_WINDOW_DAYS = 30;

export interface UsageSummary {
  readonly window: { readonly from: string; readonly to: string; readonly days: number };
  readonly counts: {
    readonly reportsReceived: number;
    readonly casesCreated: number;
    readonly decisionsPublished: number;
  };
  /** Reports per UTC day, newest first, so the console can draw the shape. */
  readonly daily: readonly { readonly day: string; readonly reportsReceived: number }[];
  readonly quota: ApplicationQuota;
  /**
   * Whether TODAY is already at the daily limit.
   *
   * Today and not the window: a limit is per day, and a window total exceeding a
   * daily limit is the normal state of any application sending on more than one day.
   * Getting this wrong would show a permanent red flag to every healthy tenant.
   */
  readonly atDailyLimit: boolean;
}

export async function usageSummary(
  context: TenantContext,
  days: number,
  now: Date = new Date(),
): Promise<UsageSummary> {
  const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const [daily, quota, casesCreated, decisionsPublished] = await Promise.all([
    reportUsageWindow(context, days, now),
    quotaForApplication(context),
    cases.countDocuments(context, { createdAt: { $gte: from } }),
    decisions.countDocuments(context, { publishedAt: { $gte: from } }),
  ]);

  const reportsReceived = daily.reduce((total, row) => total + row.reportsReceived, 0);
  // Newest first, so today's row is the head when one exists at all.
  const today: (typeof daily)[number] | undefined = daily[0];
  const todayKey = now.toISOString().slice(0, 10);

  return {
    window: { from: from.toISOString(), to: now.toISOString(), days },
    counts: { reportsReceived, casesCreated, decisionsPublished },
    daily: daily.map((row) => ({ day: row.day, reportsReceived: row.reportsReceived })),
    quota,
    atDailyLimit:
      today !== undefined &&
      today.day === todayKey &&
      today.reportsReceived >= quota.reportsPerDay,
  };
}

export interface EndpointWithHealth {
  readonly endpoint: WebhookEndpointDocument;
  readonly health: DeliveryHealth;
}

/**
 * This tenant's webhook endpoints with their delivery health.
 *
 * §10.2 defines no endpoint LIST, which the application-API route comments already
 * flag as a real gap against near-zero configuration: an integrator cannot see what
 * it has registered. The console is where that gap closes — §4.2 asks for exactly
 * this — and it closes on the session surface rather than by widening the
 * application API, so a leaked service credential still cannot enumerate the
 * endpoints it could be replaced by.
 */
export async function endpointsWithHealth(
  context: TenantContext,
): Promise<readonly EndpointWithHealth[]> {
  const endpoints = await webhookEndpoints.find(
    context,
    {},
    { sort: { createdAt: -1 }, limit: 100 },
  );

  const withHealth: EndpointWithHealth[] = [];
  for (const endpoint of endpoints) {
    withHealth.push({
      endpoint,
      health: await deliveryHealthFor(context, endpoint.webhookEndpointId),
    });
  }
  return withHealth;
}

/**
 * This tenant's own audit trail (§13.2, §15.3).
 *
 * A tenant reading its OWN trail is the point: §13.2's "audit reason" and §13.1's
 * credential-leak row are only useful to the person who can act on them, and the
 * question "which of my credentials read this case, and when" is answerable by
 * nobody else. Rows carry codes and ids and never reported material, by the
 * collection's own construction.
 */
export async function auditTrail(
  context: TenantContext,
  filter: { readonly caseId?: string; readonly limit?: number } = {},
): Promise<readonly AuditEventDocument[]> {
  return auditEvents.find(
    context,
    filter.caseId === undefined ? {} : { caseId: filter.caseId },
    { sort: { occurredAt: -1 }, limit: filter.limit ?? 100 },
  );
}
