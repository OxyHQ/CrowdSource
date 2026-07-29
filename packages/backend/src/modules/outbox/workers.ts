import { registerTriageWorker } from '../triage/triage.worker';

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
 * Event types with no consumer yet are not an omission. `report.received` is
 * published for the webhook module (§10.6) and `case.ready_for_review` for
 * sortition (§15.4); until those exist the rows are still written, still
 * durable, and still describe work whose next step is recorded in the case's own
 * state.
 */
export function registerOutboxWorkers(): void {
  registerTriageWorker();
}
