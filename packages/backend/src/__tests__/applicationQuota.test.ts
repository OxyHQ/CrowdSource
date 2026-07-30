import { describe, expect, it } from 'vitest';

import {
  APPLICATION_STANDINGS,
  type ApplicationTrustDocument,
} from '../modules/trust/applicationTrust.collection';
import { mayProduceGlobalReputationEffects } from '../modules/trust/applicationTrust.service';
import { QUOTAS_BY_STANDING, quotaFor, wouldExceedDailyReports } from '../modules/trust/quota';
import { isCreationContention } from '../modules/ingestion/report.service';

/**
 * The quota table and the global-effects gate (§11.13, §15.10, §16.2).
 *
 * Unit tests because these are the two decisions in the module that must be right
 * before any I/O happens: an off-by-one in the daily boundary either rejects a report
 * a tenant paid for or admits one past a limit an operator set, and the effects gate
 * is what §16.2 states as "una aplicación sandbox no puede producir efectos globales".
 */

function trustRow(overrides: Partial<ApplicationTrustDocument>): ApplicationTrustDocument {
  const now = new Date();
  return {
    organizationId: 'org_00000000000000000000000000000000',
    applicationId: 'app_00000000000000000000000000000000',
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
    ...overrides,
  };
}

describe('the quota table', () => {
  it('covers every standing, so a new one cannot fall through to undefined', () => {
    for (const standing of APPLICATION_STANDINGS) {
      const quota = quotaFor(standing);
      expect(quota, standing).toBeDefined();
      expect(Number.isInteger(quota.reportsPerDay), standing).toBe(true);
      expect(quota.webhookEndpoints, standing).toBeGreaterThan(0);
    }
  });

  it('permits global reputation effects at exactly one standing (§16.2)', () => {
    const permitted = APPLICATION_STANDINGS.filter(
      (standing) => QUOTAS_BY_STANDING[standing].globalReputationEffects,
    );
    expect(permitted).toEqual(['trusted']);
  });

  it('gives a restricted application no reports at all (§11.13)', () => {
    // The state for an application under investigation. A non-zero value here would
    // mean an operator who restricted an application still watched its reports arrive.
    expect(quotaFor('restricted').reportsPerDay).toBe(0);
    expect(wouldExceedDailyReports('restricted', 0)).toBe(true);
  });
});

describe('the daily report boundary', () => {
  it('admits the report that reaches the limit and refuses the one after it', () => {
    const limit = quotaFor('sandbox').reportsPerDay;

    // The count is the number stored BEFORE this report, so `limit - 1` is the last
    // one that fits. Both sides are asserted because an off-by-one passes either the
    // "admits" or the "refuses" test alone.
    expect(wouldExceedDailyReports('sandbox', limit - 2)).toBe(false);
    expect(wouldExceedDailyReports('sandbox', limit - 1)).toBe(false);
    expect(wouldExceedDailyReports('sandbox', limit)).toBe(true);
    expect(wouldExceedDailyReports('sandbox', limit + 1)).toBe(true);
  });

  it('scales with the standing rather than being one number', () => {
    const sandboxLimit = quotaFor('sandbox').reportsPerDay;
    expect(wouldExceedDailyReports('sandbox', sandboxLimit)).toBe(true);
    // The same count at a promoted standing is not over. Promotion has to actually buy
    // throughput, or §15.10's promotion path means nothing operationally.
    expect(wouldExceedDailyReports('trusted', sandboxLimit)).toBe(false);
  });
});

describe('the global reputation effects gate', () => {
  it('needs both the standing and the flag', () => {
    expect(
      mayProduceGlobalReputationEffects(
        trustRow({ standing: 'trusted', globalReputationEffectsAllowed: true }),
      ),
    ).toBe(true);

    // An operator may WITHHOLD the power at a standing that permits it — §11.13 lists
    // the flag separately, and promoting for throughput while identity binding is under
    // review is a real situation.
    expect(
      mayProduceGlobalReputationEffects(
        trustRow({ standing: 'trusted', globalReputationEffectsAllowed: false }),
      ),
    ).toBe(false);
  });

  it('refuses a sandbox row even when the stored flag says otherwise', () => {
    /**
     * The standing condition is not redundant with the flag, and this is why it is
     * there: §16.2's invariant has to hold even if a stored flag is ever wrong — set
     * by a migration, a fixture, or a future write path nobody has reviewed yet.
     */
    for (const standing of ['sandbox', 'restricted'] as const) {
      expect(
        mayProduceGlobalReputationEffects(
          trustRow({ standing, globalReputationEffectsAllowed: true }),
        ),
        standing,
      ).toBe(false);
    }
  });
});

describe('a duplicate key on the usage counter is contention, not a conflict', () => {
  /**
   * The classifier `deliverReport` branches on. Asserted directly because the race it
   * covers — two reports arriving in the same instant on the FIRST report of a UTC day,
   * before the counter document exists — cannot be produced on demand, and a branch that
   * only runs in production is a branch nobody has checked.
   */
  it('treats the counter index as retryable and a stored delivery as idempotent', () => {
    // Both creation races: retry, and the second attempt finds the winner's row.
    expect(isCreationContention({ indexFields: ['applicationId', 'day'] })).toBe(true);
    expect(
      isCreationContention({
        indexFields: ['applicationId', 'externalSubjectId', 'contentHash', 'policyVersion'],
      }),
    ).toBe(true);

    // Not races: the delivery itself is already stored, and retrying would answer 503 for
    // something that has a correct idempotent answer.
    expect(isCreationContention({ indexFields: ['applicationId', 'externalReportId'] })).toBe(
      false,
    );
    expect(isCreationContention({ indexFields: ['applicationId', 'idempotencyKey'] })).toBe(false);
    // An unattributable collision is not assumed to be retryable either.
    expect(isCreationContention({ indexFields: [] })).toBe(false);
  });
});
