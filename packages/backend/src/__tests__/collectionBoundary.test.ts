import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { registeredCollectionNames, unscopedCollectionReasons } from '../db/collections';
// Imported for their side effect: a collection is only registered once the
// module that declares it is loaded, and an empty registry would make every
// assertion below vacuously true.
//
// A PARTIAL registry is the same failure one step quieter, and it is the reason
// `every collection module is imported` below derives this list from the module
// tree instead of trusting it: two modules were missing here, so `Decision` and
// `Appeal` — the jury's own output and the appeals against it — sat outside
// every assertion in this file while the suite passed.
import '../modules/appeals/appeal.collection';
import '../modules/audit/audit.collection';
import '../modules/cases/case.collection';
import '../modules/console/console.collections';
import '../modules/console/staffAudit.collection';
import '../modules/decision/decision.collection';
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
 * This is the compatibility registry over the explicit PostgreSQL table
 * bindings. RLS ownership itself is enforced by `postgresTableBoundary`; this
 * test makes a newly declared document-shaped adapter visible instead of
 * silently leaving it outside the scoped/unscoped decision.
 */

const backendRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(backendRoot, 'src');

interface ScannedFile {
  readonly path: string;
  readonly source: string;
}

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

/** This file, read back so it can check its own import block. */
const TEST_FILE_NAME = 'collectionBoundary.test.ts';

/** Every module that declares a collection, taken from the tree, not from a list. */
const collectionModulePaths = sources
  .map((file) => file.path)
  .filter((filePath) => /^src\/modules\/.+\.collections?\.ts$/.test(filePath))
  .sort();

/** `src/modules/audit/audit.collection.ts` → `../modules/audit/audit.collection`. */
function importSpecifierFor(modulePath: string): string {
  return modulePath.replace(/^src\//, '../').replace(/\.ts$/, '');
}

/** The collection modules `source` does not import for its side effect. */
function unimportedModules(source: string, modulePaths: readonly string[]): string[] {
  return modulePaths.filter(
    (modulePath) => !source.includes(`import '${importSpecifierFor(modulePath)}';`),
  );
}

/**
 * The registry this file can see is decided by its own import block, and a
 * module missing from it is invisible in the shape that reads as success: the
 * registry is simply smaller, the exact-set assertions below are satisfied by
 * the smaller set, and nothing reports a gap.
 *
 * That is measured rather than imagined. `Decision` and `Appeal` were absent
 * from the import block, so the registry held 24 of 26 collections and the two
 * carrying the jury's decisions were outside the tenant boundary gate — while
 * every test here passed. Two independent mechanisms hid it: an unimported
 * module never registers a rationale, so the exact `toEqual` on the unscoped set
 * could not see it either; and the tenant-side assertion was
 * `expect.arrayContaining`, a SUBSET check, which cannot notice an absence at
 * all. Both are fixed below.
 *
 * Deriving the expected list from the module tree is what stops it recurring: a
 * new collection module fails this test until it is imported, instead of quietly
 * narrowing what every other assertion in this file covers.
 */
describe('the collection modules this file can see', () => {
  /**
   * The vacuity floor on the traversal itself. A filter that matched nothing
   * would make the assertion below pass while checking no modules whatsoever —
   * the same defect, one layer up.
   */
  it('found the collection modules in the source tree', () => {
    expect(collectionModulePaths.length).toBeGreaterThanOrEqual(17);
    expect(collectionModulePaths).toContain('src/modules/decision/decision.collection.ts');
    expect(collectionModulePaths).toContain('src/modules/appeals/appeal.collection.ts');
  });

  it('imports every one of them, so the registry below is complete', () => {
    const source = readFileSync(path.join(__dirname, TEST_FILE_NAME), 'utf8');

    // The full module paths, so a failure names what to import rather than
    // asserting a count somebody then has to go and diff by hand.
    expect(unimportedModules(source, collectionModulePaths)).toEqual([]);
  });

  /**
   * The mutation test. Break the thing the check guards and confirm it fails AND
   * names the offending module — otherwise the empty result above is
   * indistinguishable from a predicate that matches everything.
   */
  it('would notice a collection module that was never imported', () => {
    const onlyOne = "import '../modules/audit/audit.collection';";

    expect(
      unimportedModules(onlyOne, [
        'src/modules/audit/audit.collection.ts',
        'src/modules/decision/decision.collection.ts',
      ]),
    ).toEqual(['src/modules/decision/decision.collection.ts']);
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
   *
   * EXACT, not `expect.arrayContaining`. A subset check reports a set that has
   * everything it names, which is satisfied just as well by a registry missing
   * something — so it could never have caught `Decision` and `Appeal` going
   * absent, and it did not. An exact comparison is what makes adding a
   * tenant-owned collection an edit to this list.
   */
  it('registers exactly the tenant-owned collections, and no others', () => {
    const exempt = new Set(unscopedCollectionReasons().keys());
    const tenantScoped = registeredCollectionNames()
      .filter((name) => !exempt.has(name))
      .sort();

    expect(tenantScoped).toEqual([
      /**
       * The appeal against a decision, and the decision itself. Both are
       * tenant-owned like any other case material — and both were missing from
       * this file's import block until the gate was fixed, which is why they are
       * named first here rather than filed alphabetically without comment.
       */
      'Appeal',
      'AuditEvent',
      'Case',
      'CaseReport',
      'Decision',
      'PolicySet',
      'Report',
      /**
       * The usage meter IS scopable and therefore is scoped. It counts one tenant's
       * accepted reports, it is read by that tenant's quota check and by its own
       * console, and no cross-tenant reader needs it — so it belongs on this side of
       * the boundary even though the trust row next to it does not.
       */
      'UsageCounter',
      'WebhookAttempt',
      'WebhookEndpoint',
      'WebhookSecret',
    ]);
  });

  /**
   * The vacuity floor on the registry, which is what the two assertions above
   * are read against. Both compare against an exact list, and both would still
   * pass on a registry that had lost a collection they do not name — this is the
   * one that fails when the total moves at all, in either direction.
   */
  it('registers every declared collection', () => {
    // 11 tenant-owned above, 15 exempt in the list before it.
    expect(registeredCollectionNames()).toHaveLength(26);
    expect(unscopedCollectionReasons().size).toBe(15);
  });
});
