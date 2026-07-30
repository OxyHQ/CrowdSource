import type { ApplicationStanding } from './applicationTrust.collection';

/**
 * Quotas per application standing (§15.10: "cuotas, usage metering y billing
 * hooks"; §13.1's "aplicación maliciosa" row, whose controls are "sandbox, app
 * trust, binding proofs, cuotas").
 *
 * A source table and not configuration, for the same reason the database name is:
 * a limit that can be raised by an environment variable is a limit whose real
 * value nobody can state, and this one decides whether a tenant's reports are
 * accepted. Changing it is a code change with a review and a deploy.
 *
 * A quota nothing enforces is a fiction on a console screen, so every field here
 * names its enforcement point and there are only three:
 *
 *  - `reportsPerDay` — checked at ingress against `usageCounter.collection.ts`.
 *  - `webhookEndpoints` — checked when an endpoint is registered.
 *  - `globalReputationEffects` — read through `mayProduceGlobalReputationEffects`.
 *    Nothing calls it yet, because the reputation bridge is not built; it exists so
 *    that when the bridge lands there is one place to ask, already pinned by a
 *    test, rather than a fresh judgement call at the moment the first effect is
 *    about to be written.
 *
 * Retention is deliberately NOT here. §13.6's periods need the deletion jobs and
 * the legal-hold path of the retention module, and a ceiling enforced at ingress
 * with no deletion behind it would tell an operator that data expires when nothing
 * expires it.
 */

export interface ApplicationQuota {
  /**
   * Reports accepted per UTC day. Over it, ingress answers 429 — §10.5's "rate
   * limit or cuota" — which is a code integrators already retry from their outbox.
   */
  readonly reportsPerDay: number;
  /**
   * Active webhook endpoints. A GUARDRAIL, not a rationing device, and the numbers are
   * chosen accordingly.
   *
   * The abuse it stops is fan-out amplification: every endpoint an application
   * registers multiplies one decision into another outbound HTTP request we make on its
   * behalf, so an application allowed ten thousand endpoints turns a single case into
   * ten thousand requests to hosts of its choosing — §13.1's "aplicación maliciosa" row
   * with our own delivery workers as the amplifier. What it must NOT do is cap a
   * legitimate integrator, who genuinely wants several (production, staging, a debug
   * tunnel, a migration running in parallel), so the limits sit far above ordinary use
   * and far below an amplifier.
   */
  readonly webhookEndpoints: number;
  /** Whether a decision may reach Oxy Trust at all (§11.13, §16.2). */
  readonly globalReputationEffects: boolean;
}

/**
 * The table, keyed by standing.
 *
 * `sandbox` is generous enough for a real integration to be built and load-tested
 * against — §11.13's sandbox application "puede moderar localmente", which is
 * production traffic with local enforcement, not a toy — and small enough that an
 * application abusing the pipeline is capped before it costs a jury a day of work.
 *
 * `restricted` is zero. It is the state for an application under investigation, and
 * §11.13's whole point is that a suspect application stops producing work: a
 * non-zero value there would mean an operator who restricted an application still
 * watched its reports arrive.
 */
export const QUOTAS_BY_STANDING: Readonly<Record<ApplicationStanding, ApplicationQuota>> =
  Object.freeze({
    sandbox: Object.freeze({
      reportsPerDay: 5_000,
      webhookEndpoints: 25,
      globalReputationEffects: false,
    }),
    trusted: Object.freeze({
      reportsPerDay: 250_000,
      webhookEndpoints: 100,
      globalReputationEffects: true,
    }),
    restricted: Object.freeze({
      reportsPerDay: 0,
      webhookEndpoints: 25,
      globalReputationEffects: false,
    }),
  });

export function quotaFor(standing: ApplicationStanding): ApplicationQuota {
  return QUOTAS_BY_STANDING[standing];
}

/**
 * Whether one more report would exceed the day's allowance.
 *
 * Takes the count BEFORE this report, so the boundary is unambiguous: an
 * application with 5,000 of 5,000 already stored is over, and one with 4,999 is
 * not. A predicate rather than an inline comparison because it is asserted
 * directly in unit tests — an off-by-one here either rejects a report a tenant
 * paid for or admits one past a limit an operator set.
 */
export function wouldExceedDailyReports(
  standing: ApplicationStanding,
  reportsAlreadyToday: number,
): boolean {
  return reportsAlreadyToday >= quotaFor(standing).reportsPerDay;
}
