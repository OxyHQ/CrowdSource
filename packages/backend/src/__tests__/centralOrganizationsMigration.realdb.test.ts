import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTestDatabase, dropTestDatabase } from '@oxy.so/db/testing';
import postgres from 'postgres';
import { describe, expect, it } from 'bun:test';

const pre = readFileSync(
  path.join(import.meta.dir, '../db/postgres/migrations/0018_central_organizations_pre.sql'),
  'utf8',
);
const post = readFileSync(
  path.join(import.meta.dir, '../db/postgres/migrations/0019_central_organizations_post.sql'),
  'utf8',
);
const tenant = 'org_d7139127ac384a1da3963564cb592549';
const app = 'app_61e5372b942a493c94904a7d697c942b';
const canonical = '69b2d3df5d12f58c9800d651';
async function fixture(run: (db: postgres.Sql) => Promise<void>) {
  const url = await createTestDatabase({
    adminUrl: process.env.CROWDSOURCE_BACKEND_TEST_POSTGRES_URL,
  });
  const db = postgres(url, { max: 1, connection: { statement_timeout: 3000 }, onnotice: () => {} });
  try {
    // Historical shape before 0018. Actual generated migrations are applied below.
    await db.unsafe(`CREATE TABLE organizations (organization_id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL, status text NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX organizations_slug_lower_key ON organizations (lower(slug));
      CREATE TABLE applications (application_id text PRIMARY KEY, organization_id text NOT NULL, oxy_application_id text, name text NOT NULL);
      CREATE TABLE retained_decisions (id text PRIMARY KEY, organization_id text REFERENCES organizations(organization_id), application_id text REFERENCES applications(application_id), decision text NOT NULL);`);
    await db`INSERT INTO organizations (organization_id,name,slug,status) VALUES (${tenant},'Historical source label','oxy','active')`;
    await db`INSERT INTO applications VALUES (${app},${tenant},'6a2f851751b784a86fd0e916','Mention')`;
    await db`INSERT INTO retained_decisions VALUES ('immutable',${tenant},${app},'no_violation')`;
    await run(db);
  } finally {
    await db.end();
    await dropTestDatabase(url);
  }
}
const apply = (db: postgres.Sql, sql: string) =>
  db.begin(async (tx) => {
    await tx.unsafe(sql);
  });

describe('canonical organization cutover', () => {
  it('links only reviewed app ownership, freezes source facts and preserves historical tenant references', async () =>
    fixture(async (db) => {
      await apply(db, pre);
      expect(
        (await db`SELECT oxy_account_id FROM organizations WHERE organization_id=${tenant}`)[0]
          ?.oxy_account_id,
      ).toBe(canonical);
      await expect(db`UPDATE organizations SET name='Changed'`.execute()).rejects.toThrow(
        'managed in Oxy',
      );
      await expect(
        db`INSERT INTO organizations (organization_id,name,slug,status) VALUES ('old-writer','Old','old','active')`.execute(),
      ).rejects.toThrow('managed in Oxy');
      await db`INSERT INTO organizations (organization_id,oxy_account_id,slug,status) VALUES ('new-reference','new-canonical','new','active')`;
      await expect(
        db`UPDATE organization_identity_archives SET name='Changed'`.execute(),
      ).rejects.toThrow('immutable');
      const before = await db`SELECT * FROM retained_decisions`;
      await apply(db, post);
      expect(await db`SELECT * FROM retained_decisions`).toEqual(before);
      expect(
        await db`SELECT column_name FROM information_schema.columns WHERE table_name='organizations' AND column_name='name'`,
      ).toHaveLength(0);
      expect((await db`SELECT name FROM organization_identity_archives`)[0]?.name).toBe(
        'Historical source label',
      );
      await expect(
        db`UPDATE organizations SET oxy_account_id='hijack' WHERE organization_id=${tenant}`.execute(),
      ).rejects.toThrow('cannot be reassigned');
      await db`UPDATE organizations SET oxy_account_id=null,status='suspended' WHERE organization_id=${tenant}`;
      await expect(
        db`UPDATE organizations SET status='active' WHERE organization_id=${tenant}`.execute(),
      ).rejects.toThrow('organizations_active_identity_check');
      expect(await db`SELECT * FROM retained_decisions`).toEqual(before);
    }));
  it('does not name-match or silently cut over an unexpected organization', async () =>
    fixture(async (db) => {
      await db`INSERT INTO organizations (organization_id,name,slug,status) VALUES ('unreviewed','Oxy','other','active')`;
      await apply(db, pre);
      expect(
        (await db`SELECT oxy_account_id FROM organizations WHERE organization_id='unreviewed'`)[0]
          ?.oxy_account_id,
      ).toBeNull();
      await expect(apply(db, post)).rejects.toThrow('Reviewed organization mapping');
      expect(
        await db`SELECT name FROM organizations WHERE organization_id='unreviewed'`,
      ).toHaveLength(1);
    }));
  it('rejects the known tenant when its sole application provenance has changed', async () =>
    fixture(async (db) => {
      await db`UPDATE applications SET oxy_application_id='different-owner-proof'`;
      await apply(db, pre);
      expect((await db`SELECT oxy_account_id FROM organizations`)[0]?.oxy_account_id).toBeNull();
      await expect(apply(db, post)).rejects.toThrow('Reviewed organization mapping');
    }));
});
