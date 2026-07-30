import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { registeredCollectionNames, unscopedCollectionReasons } from '../db/collections';
import { DRIVER_ACCESS_ALLOWED, findDriverEscapes, type ScannedFile } from '../db/driverEscapes';
// Imported for their side effect: a collection is only registered once the
// module that declares it is loaded, and an empty registry would make every
// assertion below vacuously true.
import '../modules/audit/audit.collection';
import '../modules/cases/case.collection';
import '../modules/console/console.collections';
import '../modules/console/staffAudit.collection';
import '../modules/ingestion/report.collection';
import '../modules/trust/applicationTrust.collection';
import '../modules/trust/usageCounter.collection';
import '../modules/outbox/outbox.collection';
import '../modules/policy/policySet.collection';
import '../modules/review/review.collection';
import '../modules/reviewer/reviewer.collection';
import '../modules/sortition/assignment.collection';
import '../modules/sortition/draw.collection';
import '../modules/tenancy/tenancy.collections';
import '../modules/webhooks/webhook.collections';

/**
 * The gate on the tenant boundary.
 *
 * Nothing in MongoDB stops a query that forgets its tenant filter, so the
 * boundary is only as strong as the rule that every query goes through
 * `src/db`. This test is what enforces that rule, and — following the lesson
 * that a check unable to fail is worse than no check — it carries its own
 * mutation test and its own vacuity floor.
 */

const backendRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(backendRoot, 'src');

function collectSources(directory: string): ScannedFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Tests are excluded deliberately: asserting on what is actually STORED,
      // straight off the driver, is exactly how the isolation tests avoid
      // proving only that the wrapper agrees with itself.
      return entry.name === '__tests__' ? [] : collectSources(absolute);
    }
    if (!entry.name.endsWith('.ts')) return [];
    return [
      {
        path: path.relative(backendRoot, absolute).replaceAll(path.sep, '/'),
        source: readFileSync(absolute, 'utf8'),
      },
    ];
  });
}

const sources = collectSources(sourceRoot);

describe('driver access', () => {
  /**
   * The vacuity floor. A traversal that silently returned nothing would make the
   * assertion below pass while checking no files whatsoever.
   */
  it('scanned the source tree', () => {
    expect(sources.length).toBeGreaterThanOrEqual(15);
    expect(sources.map((file) => file.path)).toContain('src/modules/ingestion/report.service.ts');
  });

  it('no module outside the access layer reaches the driver', () => {
    const escapes = findDriverEscapes(sources);

    // The full offending lines, so a failure names what to fix rather than just
    // asserting a count.
    expect(escapes.map((escape) => `${escape.path}:${escape.line} ${escape.rule} — ${escape.text}`))
      .toEqual([]);
  });

  /**
   * The mutation test. Break the thing the check guards and confirm the check
   * fails AND names the offending path — otherwise the empty result above is
   * indistinguishable from a scanner that matches nothing.
   */
  it('detects each escape it claims to detect', () => {
    const violations: ScannedFile[] = [
      { path: 'src/modules/cases/case.service.ts', source: 'const M = mongoose.model("Report");' },
      {
        path: 'src/modules/cases/case.service.ts',
        source: 'await connection.collection("reports").find({});',
      },
      { path: 'src/modules/cases/case.service.ts', source: 'const db = connection.db;' },
    ];

    for (const violation of violations) {
      const found = findDriverEscapes([violation]);
      expect(found).toHaveLength(1);
      expect(found[0].path).toBe('src/modules/cases/case.service.ts');
      expect(found[0].text).toBe(violation.source);
    }
  });

  it('does not flag the access layer it exists to protect', () => {
    for (const allowed of Object.keys(DRIVER_ACCESS_ALLOWED)) {
      const escapes = findDriverEscapes([
        { path: `${allowed}${allowed.endsWith('/') ? 'anything.ts' : ''}`, source: 'mongoose.model("X")' },
      ]);
      expect(escapes).toEqual([]);
    }
  });

  it('does not mistake a comment about the rule for a breach of it', () => {
    const escapes = findDriverEscapes([
      {
        path: 'src/modules/cases/case.service.ts',
        source: [
          '// Never call mongoose.model( here.',
          ' * The escape hatch is connection.db and it is watched.',
          'const scoped = reports.findOne(context, {});',
        ].join('\n'),
      },
    ]);

    expect(escapes).toEqual([]);
  });
});

describe('the directories allowed to reach the driver', () => {
  /**
   * Pinned to an exact set, for the same reason the unscoped collections below are.
   *
   * Until this existed, `DRIVER_ACCESS_ALLOWED` was the one authority in the access
   * layer that no test constrained: a new directory could be added to it and the whole
   * suite would still pass, so the FIRST entry to arrive would set the precedent that
   * entries arrive without a test change — and a pin added afterwards would simply bless
   * whatever was already there. Widening the allowlist is now an edit to this list too.
   */
  it('is exactly the set that owns the connection, each with a stated reason', () => {
    expect(Object.keys(DRIVER_ACCESS_ALLOWED).sort()).toEqual([
      'src/db/',
      /**
       * The privileged cross-tenant reads. A FILE and not a directory: Trust & Safety
       * reads across tenants by design (§4.3), and confining that to one named module of
       * projected queries is what keeps every future cross-tenant read a reviewed
       * addition instead of a new filter passed to an already-sanctioned call.
       */
      'src/modules/trust/crossTenantReads.ts',
      'src/utils/database.ts',
      'src/utils/mongoTopology.ts',
    ]);

    for (const [path, why] of Object.entries(DRIVER_ACCESS_ALLOWED)) {
      expect(why.trim().length, `${path} must say why it may reach the driver`).toBeGreaterThanOrEqual(30);
    }
  });

  /**
   * The vacuity guard on the pin itself: prove the comparison can distinguish a widened
   * set from the pinned one. Without this, a pin whose expectation was accidentally
   * written as the actual value would pass forever while checking nothing.
   */
  it('would notice a directory that was added without updating the pin', () => {
    const widened = [...Object.keys(DRIVER_ACCESS_ALLOWED), 'src/modules/somewhere/'].sort();
    expect(widened).not.toEqual(Object.keys(DRIVER_ACCESS_ALLOWED).sort());
  });
});

describe('collections that are exempt from tenant scoping', () => {
  /**
   * Pinned, so adding an exemption is an edit to this list and not something
   * that happens quietly inside a module. Each entry has to justify itself in
   * source; this asserts the justification exists and that the set is what was
   * agreed.
   */
  it('is exactly the set that cannot be scoped, each with a stated reason', () => {
    const reasons = unscopedCollectionReasons();

    expect([...reasons.keys()].sort()).toEqual([
      'Application',
      'ApplicationCredential',
      /**
       * Application standing. Trust & Safety compares it ACROSS applications
       * (§4.3), and the ingestion gate reads the row that is about to establish
       * the tenant — so a filter by that tenant would be circular. Every read
       * serving one tenant goes through `applicationTrustFor`, which states the
       * filter explicitly.
       */
      'ApplicationTrust',
      /**
       * The jury collections. A case belongs to one tenant; a REVIEWER belongs
       * to none — they are drawn across every application, and the caller
       * reading these presents an Oxy session, which carries no tenant to scope
       * by. Every row is still stamped with the tenant of its case, taken from
       * the case document inside the draw's own transaction.
       */
      'Assignment',
      'Organization',
      /**
       * A console membership is what ESTABLISHES the tenant for a session caller, so
       * the tenant a filter would use is derived from this very row. Nothing outside
       * `src/modules/console/` imports it, and no route returns a row that was not
       * resolved from the caller's own authenticated Oxy identity.
       */
      'OrganizationMember',
      'OutboxEvent',
      'Review',
      'ReviewerAffinity',
      'ReviewerProfile',
      'ReviewerRelation',
      'SortitionDraw',
      /**
       * The trail of privileged activity. A staff read spans every tenant at once, so
       * filing it in the tenant-scoped `audit_events` would force a choice between an
       * incomplete trail and filling every customer's trail with operator activity.
       */
      'StaffAuditEvent',
      /**
       * Trust & Safety staff act ACROSS every tenant by definition (§4.3), so there
       * is no tenant to scope the row by. The row grants authority rather than
       * belonging to a customer.
       */
      'TrustSafetyStaff',
      /**
       * The webhook delivery worker's CLAIM spans every tenant, exactly like the
       * outbox dispatcher's, so the row it claims cannot be found through a
       * tenant filter. Its attempts are tenant-scoped — the worker derives a
       * context from the delivery row it just claimed — which is why only one of
       * the four webhook collections appears here.
       */
      'WebhookDelivery',
    ]);
    for (const [name, why] of reasons) {
      expect(why.trim().length, `${name} must say why it is exempt`).toBeGreaterThanOrEqual(30);
    }
  });

  /**
   * The other half of the pin. Every collection that CAN be tenant-scoped must
   * be, so a new one added as unscoped shows up as a failure in the list above
   * and a new one added as scoped shows up here.
   */
  it('registers the tenant-owned collections too', () => {
    expect(registeredCollectionNames()).toEqual(
      expect.arrayContaining([
        'Report',
        'Case',
        'CaseReport',
        'PolicySet',
        'AuditEvent',
        'WebhookEndpoint',
        'WebhookSecret',
        'WebhookAttempt',
        /**
         * The usage meter IS scopable and therefore is scoped. It counts one tenant's
         * accepted reports, it is read by that tenant's quota check and by its own
         * console, and no cross-tenant reader needs it — so it belongs on this side of
         * the boundary even though the trust row next to it does not.
         */
        'UsageCounter',
      ]),
    );
  });
});
