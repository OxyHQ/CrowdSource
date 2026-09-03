import type { TransactionSession } from '../../db/collections';

import type { TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import {
  applicationTrust,
  type ApplicationStanding,
  type ApplicationTrustDocument,
  type StandingReason,
} from './applicationTrust.collection';
import { quotaFor, wouldExceedDailyReports, type ApplicationQuota } from './quota';
import { reportsReceivedOn } from './usageCounter.collection';

/**
 * Application standing and the gates that read it (§11.13, §16.2).
 *
 * Three separate powers live here and they are deliberately not one function:
 * whether an application may INGEST at all, how much it may ingest, and whether
 * its decisions may ever reach Oxy Trust. §11.13 makes the third the one that
 * needs a technical review, an identity verification and a quality period behind
 * it, so it must not be something the first two grant as a side effect.
 */

/**
 * The standing of an application that has no row yet.
 *
 * A default rather than a throw, and the direction matters: the safe answer to
 * "we have no record of this application's standing" is the most restricted state
 * it could be in that still lets it work, which is exactly `sandbox`. Throwing
 * would take ingestion down for every application provisioned before this module
 * existed; assuming `trusted` would hand an unreviewed application the power to
 * move a reputation figure.
 */
function sandboxDefault(
  organizationId: string,
  applicationId: string,
  now: Date,
): ApplicationTrustDocument {
  return {
    organizationId,
    applicationId,
    standing: 'sandbox',
    globalReputationEffectsAllowed: false,
    evidenceIntegrity: null,
    identityBindingReliability: null,
    policyQuality: null,
    lastStandingReason: 'initial',
    standingChangedAt: null,
    standingChangedByOxyUserId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Creates the trust row for a new application.
 *
 * Called by provisioning inside its own write, so an application and its standing
 * come into existence together. Idempotent: a second call finds the row and
 * changes nothing, which is what makes it safe to call from a retried creation.
 */
export async function createApplicationTrust(
  organizationId: string,
  applicationId: string,
  session?: TransactionSession,
): Promise<void> {
  const existing = await applicationTrust.findOne({ applicationId });
  if (existing) return;

  await applicationTrust.insertOne(
    sandboxDefault(organizationId, applicationId, new Date()),
    session,
  );
}

/**
 * Reads one application's trust row, filtered by tenant.
 *
 * `app_trust_snapshots` is exempt from the tenant filter because Trust & Safety
 * reads across every application — and that exemption is exactly why every read
 * serving a TENANT goes through this function. The filter is explicit here so
 * there is one place to audit rather than one per call site.
 */
export async function applicationTrustFor(
  context: TenantContext,
): Promise<ApplicationTrustDocument> {
  const stored = await applicationTrust.findOne({
    applicationId: context.applicationId,
    organizationId: context.organizationId,
  });
  return (
    stored ?? sandboxDefault(context.organizationId, context.applicationId, new Date())
  );
}

/** The quota this application is currently entitled to. */
export async function quotaForApplication(context: TenantContext): Promise<ApplicationQuota> {
  return quotaFor((await applicationTrustFor(context)).standing);
}

/**
 * Whether a decision about this application's cases may move an Oxy Trust figure.
 *
 * Two conditions, and the standing one is not redundant: it makes §16.2's "una
 * aplicación sandbox no puede producir efectos globales" true even if a stored flag
 * is ever wrong — a row that somehow carries `globalReputationEffectsAllowed` while
 * sitting in `sandbox` still answers false.
 *
 * Nothing calls this yet. The reputation bridge is not built, and the point of
 * defining it now is that when it is, the answer is already one function with a
 * test on it rather than a judgement made at the moment the first effect is about
 * to be written.
 */
export function mayProduceGlobalReputationEffects(trust: ApplicationTrustDocument): boolean {
  return trust.standing === 'trusted' && trust.globalReputationEffectsAllowed;
}

/**
 * The ingestion gate (§13.1's "aplicación maliciosa" controls, §15.10's quotas).
 *
 * Two refusals with two different meanings, and answering the wrong one misleads
 * an integrator badly:
 *
 *  - A `restricted` application is refused 403 — §10.5's "capacidad no autorizada".
 *    Retrying will not help; an operator has to move its standing back.
 *  - An application over its daily allowance is refused 429. §10.5 gives that code
 *    to "rate limit o cuota", and an integrator's outbox already retries it, which
 *    is the correct behaviour: tomorrow the same delivery succeeds.
 *
 * Called BEFORE the ingestion transaction opens. A refusal should not run an abort
 * path, and a quota check inside the transaction would read a counter the same
 * transaction is about to increment.
 */
export async function assertApplicationMayIngest(
  context: TenantContext,
  now: Date = new Date(),
): Promise<void> {
  const trust = await applicationTrustFor(context);

  if (trust.standing === 'restricted') {
    throw new ApiError(
      'forbidden',
      'This application is restricted and cannot deliver reports. Contact Trust & Safety.',
    );
  }

  const today = await reportsReceivedOn(context, now);
  if (wouldExceedDailyReports(trust.standing, today)) {
    throw new ApiError(
      'rate_limited',
      `This application has reached its daily report quota of ${quotaFor(trust.standing).reportsPerDay}. Retry after 00:00 UTC.`,
      { standing: trust.standing, reportsToday: today },
    );
  }
}

export interface StandingChange {
  readonly applicationId: string;
  readonly standing: ApplicationStanding;
  readonly reason: StandingReason;
  /** The staff member making the change, for the §13.2 audit question. */
  readonly byOxyUserId: string;
  /**
   * Whether global reputation effects are permitted at the new standing.
   *
   * Defaults to what the standing's quota allows. An operator may WITHHOLD the
   * power at a standing that permits it — §11.13 lists the flag separately from
   * standing, and promoting an application for throughput while identity binding is
   * still under review is a real situation — but never grant it beyond the table,
   * which is enforced below rather than trusted.
   */
  readonly globalReputationEffectsAllowed?: boolean;
}

/**
 * Moves an application's standing. Trust & Safety only, never the tenant's own
 * console: the whole purpose of standing is to be a judgement made ABOUT an
 * application by somebody other than its owner.
 */
export async function setApplicationStanding(
  change: StandingChange,
): Promise<ApplicationTrustDocument> {
  const existing = await applicationTrust.findOne({ applicationId: change.applicationId });
  if (!existing) {
    throw new ApiError('not_found', 'No such application.');
  }

  const permitted = quotaFor(change.standing).globalReputationEffects;
  const requested = change.globalReputationEffectsAllowed ?? permitted;
  const now = new Date();

  await applicationTrust.updateOne(
    { applicationId: change.applicationId },
    {
      standing: change.standing,
      // `&&` and not the requested value: a standing whose table forbids global
      // effects can never be talked into permitting them, whatever was asked for.
      globalReputationEffectsAllowed: requested && permitted,
      lastStandingReason: change.reason,
      standingChangedAt: now,
      standingChangedByOxyUserId: change.byOxyUserId,
      updatedAt: now,
    },
  );

  const updated = await applicationTrust.findOne({ applicationId: change.applicationId });
  if (!updated) {
    throw new ApiError('not_found', 'No such application.');
  }
  return updated;
}

/**
 * Every application's standing, for the Trust & Safety surface (§4.3).
 *
 * The one read in this module that is not tenant-filtered, and the only caller is
 * a route behind a staff role. It returns standing and quality signals — never a
 * case, a report or anything from another tenant's material.
 */
export async function listApplicationTrust(
  filter: { readonly standing?: ApplicationStanding } = {},
  limit = 200,
): Promise<readonly ApplicationTrustDocument[]> {
  return applicationTrust.find(
    filter.standing === undefined ? {} : { standing: filter.standing },
    { sort: { updatedAt: -1 }, limit },
  );
}

/** How many applications sit in each standing. The T&S dashboard's headline. */
export async function applicationCountsByStanding(): Promise<
  Readonly<Record<ApplicationStanding, number>>
> {
  const [sandbox, trusted, restricted] = await Promise.all([
    applicationTrust.countDocuments({ standing: 'sandbox' }),
    applicationTrust.countDocuments({ standing: 'trusted' }),
    applicationTrust.countDocuments({ standing: 'restricted' }),
  ]);
  return { sandbox, trusted, restricted };
}
