/**
 * How long this package keeps the two things it writes down for its own sake.
 *
 * Policy, not storage, which is why it lives in the shared half: a deployment
 * whose outbox rows expired after an hour and whose event rows expired after
 * ninety days would have two different answers to "what happened to that
 * report", and neither backend would consider that an error. Both stores are
 * handed the computed `expiresAt` rather than the window, so the window has one
 * definition.
 *
 * How the deadline is ENFORCED is a backend's business — a Mongo TTL index on
 * `expiresAt`, an expiry sweep on Postgres — but a table registered with
 * neither grows forever with no error and no failing test.
 */

/**
 * The outbox.
 *
 * A retention ceiling, so a stalled dispatcher cannot turn the outbox into an
 * unbounded table. Long, because a moderation case can legitimately sit open for
 * weeks and a `dead_letter` event is evidence somebody still has to look at.
 * Operational alerts must fire long before this deadline.
 */
export const MODERATION_OUTBOX_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * Inbound webhook events.
 *
 * CrowdSource's retry schedule ends at 24 hours, so a dedupe row only has to
 * outlive that. It is kept far longer because the row is also the audit trail of
 * what a third party told this deployment to do, and an enforcement question
 * asked weeks later is answered from here.
 */
export const MODERATION_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
