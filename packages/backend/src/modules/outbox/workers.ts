import { registerTriageWorker } from '../triage/triage.worker';
import { registerWebhookFanout } from '../webhooks/fanout';

/**
 * Wires every outbox consumer, in one place.
 *
 * Registration is a pure map write, so it deliberately does NOT live in
 * `app.ts` — building the HTTP application must stay free of side effects — and
 * it does not live in the dispatcher either, which would make the dispatcher
 * import every module it dispatches to and undo the module boundaries the outbox
 * exists to create. `server.ts` calls this once at boot; a test calls it when it
 * wants the chain to run.
 *
 * Event types with no consumer yet are not an omission. `case.ready_for_review`
 * waits for sortition (§15.4); until it exists the rows are still written, still
 * durable, and still describe work whose next step is recorded in the case's own
 * state.
 *
 * The webhook fan-out registers itself for every internal event it translates
 * (today `report.received`), which is why this file does not name them: the
 * mapping belongs to `webhooks/fanout.ts`, so a module that publishes an event
 * never has to know that webhooks exist.
 */
export function registerOutboxWorkers(): void {
  registerTriageWorker();
  registerWebhookFanout();
}
