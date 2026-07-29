import type { WebhookEventType } from '@oxyhq/crowdsource-contracts';

import { createTenantContext, type TenantContext } from '../../db/tenantScope';
import { reports } from '../ingestion/report.collection';
import {
  OUTBOX_EVENT_TYPES,
  type OutboxEventDocument,
  type OutboxEventType,
} from '../outbox/outbox.collection';
import { registerOutboxHandler } from '../outbox/outbox.dispatcher';
import { buildWebhookEventBody, recordDelivery } from './delivery.service';
import { endpointsSubscribedTo } from './endpoint.service';

/**
 * Turning an internal event into logical deliveries (§10.6, §12.5).
 *
 * ## Why the mapping lives here and not in the module that publishes the event
 *
 * Cross-module communication goes through the outbox, so a module that publishes
 * a decision must not know that webhooks exist. This file is the other side of
 * that: the webhook module registers itself as the CONSUMER of the internal
 * events that happen to be tenant-visible, and owns the translation. Adding an
 * event is an entry in `WEBHOOK_EVENT_SOURCES` below and nothing anywhere else.
 *
 * ## What is wired today, and what is waiting on Phase 4
 *
 * Only `report.received`, because it is the only one of §10.6's eight events the
 * domain currently emits. `case.decided`, `decision.corrected`, `appeal.created`,
 * `appeal.decided` and `case.closed` are published by consensus, decisions and
 * appeals, none of which exist yet; `case.created` and `case.escalated` are
 * observable inside ingestion and triage but are not published to the outbox, and
 * publishing them means editing those modules rather than this one.
 *
 * That is a real limit and it is stated rather than papered over: the delivery
 * machinery below is exercised end to end by `report.received`, and every other
 * event type becomes a three-line entry in the table when the module that owns
 * it starts publishing.
 *
 * ## Why the event id is the outbox row's id
 *
 * §10.7's envelope carries an `id`, and §10.8 tells receivers to store it for
 * idempotency. Reusing the outbox row's id makes that one value all the way
 * through: replaying the outbox row produces the same `(endpoint, event)` pairs,
 * the unique index refuses the second insert, and the receiver's own dedupe keys
 * on the same string it already saw. An id minted here instead would make every
 * outbox replay look like a brand new event to the tenant.
 */

/** Builds the `data` member of §10.7's envelope for one internal event. */
type WebhookDataBuilder = (
  context: TenantContext,
  event: OutboxEventDocument,
) => Promise<Record<string, unknown> | null>;

interface WebhookEventSource {
  readonly webhookEventType: WebhookEventType;
  readonly buildData: WebhookDataBuilder;
}

/**
 * `report.received` — §10.6's "optional confirmation of receipt and merge".
 *
 * The outbox row carries ids only, so the payload is read back from the report
 * rather than carried on the event. That is the right direction: an outbox
 * payload that grew to hold everything a consumer might want would be a copy of
 * the domain in a collection that gets copied into logs and metrics.
 *
 * The shape is `CreateReportResponseSchema` — the same body §10.4 answers the
 * delivery with — so a tenant that missed the 202 gets exactly what it would
 * have received.
 */
const buildReportReceivedData: WebhookDataBuilder = async (context, event) => {
  const reportId = event.payload.reportId;
  if (!reportId) return null;

  const report = await reports.findOne(context, { reportId });
  if (!report) return null;

  return {
    reportId: report.reportId,
    caseId: report.caseId,
    status: report.status,
    merged: report.status === 'merged',
  };
};

/**
 * Which internal events become which webhook events.
 *
 * A table rather than a switch so the set is readable in one place and a missing
 * consumer is a visibly empty row rather than a fallthrough.
 */
const WEBHOOK_EVENT_SOURCES: ReadonlyMap<OutboxEventType, WebhookEventSource> = new Map([
  [
    OUTBOX_EVENT_TYPES.reportReceived,
    { webhookEventType: 'report.received', buildData: buildReportReceivedData },
  ],
]);

export interface FanoutSummary {
  /** Endpoints subscribed to this event for this tenant. */
  readonly subscribed: number;
  /** Deliveries this run actually created. Zero on a replay. */
  readonly created: number;
}

/**
 * Fans one internal event out to every subscribed endpoint.
 *
 * Not transactional, deliberately. A duplicate key inside a transaction aborts
 * the whole transaction, so a replay — which is the NORMAL case for an
 * at-least-once consumer — would abort and retry forever. Instead each delivery
 * is written independently and a collision means "already recorded", which is
 * exactly what the unique index is there to tell us.
 *
 * A partial run is safe for the same reason: the outbox row is only marked
 * dispatched once this returns, so a crash halfway through replays the whole
 * fan-out and the rows already written are recognised rather than duplicated.
 */
export async function fanOutWebhookEvent(event: OutboxEventDocument): Promise<FanoutSummary> {
  const source = WEBHOOK_EVENT_SOURCES.get(event.type);
  if (!source) {
    // Unreachable: handlers are registered from this same table. Throwing rather
    // than returning keeps the outbox row pending instead of marking work done
    // that nobody did.
    throw new Error(`No webhook mapping for internal event type '${event.type}'.`);
  }

  const context = createTenantContext(event.organizationId, event.applicationId);
  const endpoints = await endpointsSubscribedTo(context, source.webhookEventType);
  if (endpoints.length === 0) {
    // Nobody subscribed. Not a failure — most tenants subscribe to a few of the
    // eight — and nothing is written, so a later registration does not
    // retroactively receive events from before it existed.
    return { subscribed: 0, created: 0 };
  }

  const data = await source.buildData(context, event);
  if (data === null) {
    throw new Error(
      `Internal event '${event.eventId}' names a ${source.webhookEventType} payload that could not be read.`,
    );
  }

  const body = buildWebhookEventBody({
    eventId: event.eventId,
    eventType: source.webhookEventType,
    occurredAt: event.createdAt,
    organizationId: event.organizationId,
    applicationId: event.applicationId,
    data,
  });

  let created = 0;
  for (const endpoint of endpoints) {
    const wrote = await recordDelivery(context, {
      webhookEndpointId: endpoint.webhookEndpointId,
      eventId: event.eventId,
      eventType: source.webhookEventType,
      body,
    });
    if (wrote) created += 1;
  }

  return { subscribed: endpoints.length, created };
}

/** Wires the fan-out to every internal event the table names. */
export function registerWebhookFanout(): void {
  for (const type of WEBHOOK_EVENT_SOURCES.keys()) {
    registerOutboxHandler(type, async (event) => {
      await fanOutWebhookEvent(event);
    });
  }
}

/** The internal events this module consumes. Read by the test that pins the set. */
export function webhookSourcedEventTypes(): readonly OutboxEventType[] {
  return [...WEBHOOK_EVENT_SOURCES.keys()];
}
