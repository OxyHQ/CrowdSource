import { readFileSync } from 'node:fs';
import path from 'node:path';

import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as consoleRepository from '../db/postgres/repositories/console';
import { staffAuditEvents } from '../db/postgres/schema/console';
import {
  createPostgresTestDatabase,
  type PostgresTestDatabase,
} from './support/postgresTestDatabase';

/**
 * The console repositories, against a real PostgreSQL server.
 *
 * Same reason as the tenancy suite: these have no production caller yet, so
 * without this they would be statements whose first execution is in production.
 *
 * Three tables with three different exemption kinds, and the assertions below are
 * shaped by the difference rather than by uniformity — the membership read that
 * ESTABLISHES a tenant, a staff table with no tenant dimension at all, and an
 * audit trail that names an application without belonging to it.
 */

let database: PostgresTestDatabase;

beforeAll(async () => {
  database = await createPostgresTestDatabase();
}, 120_000);

afterAll(async () => {
  await database?.close();
});

const ORGANIZATION_ID = 'org_console_fixture';
const OWNER_USER = 'oxy_owner';
const SECOND_OWNER = 'oxy_owner_two';
const STAFF_USER = 'oxy_staff';

describe('organization members — the read that establishes a tenant', () => {
  it('inserts memberships and finds the active ones for a person', async () => {
    await consoleRepository.insertOrganizationMember(database.db, {
      membershipId: 'mem_one',
      organizationId: ORGANIZATION_ID,
      oxyUserId: OWNER_USER,
      roles: ['owner'],
      status: 'active',
    });
    await consoleRepository.insertOrganizationMember(database.db, {
      membershipId: 'mem_two',
      organizationId: 'org_console_other',
      oxyUserId: OWNER_USER,
      roles: ['admin'],
      status: 'revoked',
    });

    /**
     * Keyed on the Oxy account alone, with NO tenant term — which is the whole
     * reason this table is `defines_the_tenant`. The revoked row is the
     * discriminator: a query that forgot its status filter would return two, and a
     * fixture with only active rows could not tell the two implementations apart.
     */
    const active = await consoleRepository.findActiveMembershipsByUser(database.db, OWNER_USER);
    expect(active.map((row) => row.organizationId)).toEqual([ORGANIZATION_ID]);
  });

  it('finds one membership by the organization and user pair', async () => {
    const found = await consoleRepository.findOrganizationMember(
      database.db,
      ORGANIZATION_ID,
      OWNER_USER,
    );
    expect(found?.membershipId).toBe('mem_one');

    expect(
      await consoleRepository.findOrganizationMember(database.db, ORGANIZATION_ID, 'oxy_absent'),
    ).toBeNull();
  });

  it('updates roles and status, together and separately', async () => {
    expect(
      await consoleRepository.updateOrganizationMember(database.db, ORGANIZATION_ID, OWNER_USER, {
        roles: ['owner', 'admin'],
      }),
    ).toBe(1);

    const afterRoles = await consoleRepository.findOrganizationMember(
      database.db,
      ORGANIZATION_ID,
      OWNER_USER,
    );
    expect(afterRoles?.roles.sort()).toEqual(['admin', 'owner']);
    // The untouched half survived a partial patch.
    expect(afterRoles?.status).toBe('active');

    expect(
      await consoleRepository.updateOrganizationMember(database.db, ORGANIZATION_ID, 'oxy_absent', {
        status: 'revoked',
      }),
    ).toBe(0);
  });

  /**
   * The last-owner guard's input.
   *
   * `roles` is a `text[]`, so this has to be array membership rather than
   * equality — and the fixture makes that distinction real: the first owner also
   * holds `admin`, so a comparison treating the column as a scalar would miss it
   * and report one owner where there are two. That is the direction that matters,
   * because under-counting owners is what lets the last one revoke themselves.
   */
  it('counts active members holding a role, including multi-role members', async () => {
    await consoleRepository.insertOrganizationMember(database.db, {
      membershipId: 'mem_three',
      organizationId: ORGANIZATION_ID,
      oxyUserId: SECOND_OWNER,
      roles: ['owner'],
      status: 'active',
    });
    await consoleRepository.insertOrganizationMember(database.db, {
      membershipId: 'mem_four',
      organizationId: ORGANIZATION_ID,
      oxyUserId: 'oxy_revoked_owner',
      roles: ['owner'],
      status: 'revoked',
    });

    const owners = await consoleRepository.countActiveMembersWithRole(
      database.db,
      ORGANIZATION_ID,
      'owner',
    );
    expect(owners).toBe(2);
    expect(typeof owners).toBe('number');

    expect(
      await consoleRepository.countActiveMembersWithRole(database.db, ORGANIZATION_ID, 'viewer'),
    ).toBe(0);
  });

  it('lists an organization’s members oldest first', async () => {
    const listed = await consoleRepository.listOrganizationMembers(database.db, ORGANIZATION_ID);
    expect(listed.map((row) => row.membershipId)).toEqual(['mem_one', 'mem_three', 'mem_four']);
  });
});

describe('trust and safety staff — no tenant dimension at all', () => {
  it('inserts, finds and updates a staff row', async () => {
    await consoleRepository.insertTrustSafetyStaff(database.db, {
      oxyUserId: STAFF_USER,
      roles: ['security'],
      status: 'active',
    });

    expect((await consoleRepository.findTrustSafetyStaff(database.db, STAFF_USER))?.roles).toEqual([
      'security',
    ]);

    const revokedAt = new Date();
    expect(
      await consoleRepository.updateTrustSafetyStaff(database.db, STAFF_USER, {
        status: 'revoked',
        revokedAt,
      }),
    ).toBe(1);

    const stored = await consoleRepository.findTrustSafetyStaff(database.db, STAFF_USER);
    expect(stored?.status).toBe('revoked');
    expect(stored?.revokedAt?.getTime()).toBe(revokedAt.getTime());

    expect(await consoleRepository.findTrustSafetyStaff(database.db, 'oxy_absent')).toBeNull();
    expect(
      await consoleRepository.updateTrustSafetyStaff(database.db, 'oxy_absent', {
        status: 'active',
      }),
    ).toBe(0);
  });
});

describe('the staff audit trail — names an application without belonging to one', () => {
  /**
   * Both shapes of the nullable column, which is the distinction the registry
   * declares as `application_nullable` and the schema enforces. A fixture that
   * only ever supplied an application id could not tell this column from
   * `reviewer_relations`' required one.
   */
  it('appends events with and without an application', async () => {
    await consoleRepository.appendStaffAuditEvent(database.db, {
      staffAuditId: 'audit_with_app',
      action: 'staff.standing.changed',
      actorOxyUserId: STAFF_USER,
      roles: ['security'],
      applicationId: 'app_console_fixture',
      occurredAt: new Date('2026-08-10T01:00:00.000Z'),
    });

    await consoleRepository.appendStaffAuditEvent(database.db, {
      staffAuditId: 'audit_without_app',
      action: 'staff.metrics.read',
      actorOxyUserId: STAFF_USER,
      roles: ['security'],
      applicationId: null,
      occurredAt: new Date('2026-08-10T02:00:00.000Z'),
    });

    /**
     * The read is INLINE, not a repository export.
     *
     * `staff_audit_events` is write-only in production, and a repository function
     * with no caller after the switch would be an export that exists to be tested
     * — which is exactly what the "repositories may not land unused" rule is
     * against. A repository may precede its caller because the switch supplies
     * one; nothing will supply one here until Trust & Safety grows a reader.
     *
     * The property is still worth proving, so it is proved here: the trail is
     * readable and comes back newest-first. When a real reader arrives, the query
     * moves into `repositories/console.ts` with it.
     */
    const trail = await database.db
      .select()
      .from(staffAuditEvents)
      .where(eq(staffAuditEvents.actorOxyUserId, STAFF_USER))
      .orderBy(desc(staffAuditEvents.occurredAt))
      .limit(100);

    // Newest first.
    expect(trail.map((row) => row.staffAuditId)).toEqual(['audit_without_app', 'audit_with_app']);
    expect(trail[0].applicationId).toBeNull();
    expect(trail[1].applicationId).toBe('app_console_fixture');
  });
});

describe('the suite exercises the whole module', () => {
  /**
   * The completeness claim, checked rather than asserted in prose. A repository
   * function added later fails this until it is exercised — otherwise "the suite
   * covers every export" decays silently, which is precisely the shape that let a
   * foundation land with a suite that did not move.
   */
  it('names every exported function somewhere in this file', () => {
    const exported = Object.entries(consoleRepository)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    expect(exported.length).toBeGreaterThanOrEqual(10);

    const source = readFileSync(path.join(__dirname, 'consoleRepositories.realdb.test.ts'), 'utf8');
    const unexercised = exported.filter((name) => !source.includes(`consoleRepository.${name}(`));

    expect(unexercised).toEqual([]);
  });
});
