#!/usr/bin/env bun

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import postgres from 'postgres';

import { createPostgresTestDatabase } from '../packages/backend/src/__tests__/support/postgresTestDatabase.ts';
import {
  BACKEND_DATASETS,
  FREEZE_FORMAT,
  createSourceBundle,
  databaseFingerprint,
  finalManifestViolations,
  signFreezeAttestation,
  verifyFinalManifestEvidence,
} from './crowdsource-backend-cutover-lib.mjs';
import {
  assertPostgresTarget,
  countTargetRows,
  importPostgres,
  postgresCatalogEvidence,
  reexportPostgres,
  targetFingerprintForUrl,
} from './crowdsource-backend-cutover-postgres.mjs';

const adminUrl = process.env.CROWDSOURCE_BACKEND_TEST_POSTGRES_URL;
if (adminUrl === undefined || adminUrl.length === 0) {
  throw new Error('CROWDSOURCE_BACKEND_TEST_POSTGRES_URL is required for the real cutover test.');
}

const sourceDatabase = 'crowdsource-production';
const sourceUrl = `mongodb://cutover_reader:not-recorded@db.internal:27017/${sourceDatabase}?replicaSet=rs0`;
const sourceFingerprint = databaseFingerprint(sourceUrl, sourceDatabase, 'mongodb');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const freeze = signFreezeAttestation({
  format: FREEZE_FORMAT,
  sourceDatabase,
  sourceDatabaseFingerprint: sourceFingerprint,
  changeId: 'CHG-REALDB-CUTOVER-TEST',
  writesFrozen: true,
  observedFrom: '2026-09-02T18:01:00.000Z',
  observedUntil: '2026-09-02T18:02:00.000Z',
  nonce: randomBytes(32).toString('base64'),
  writers: [{
    id: 'crowdsource-realdb-fixture',
    stoppedAt: '2026-09-02T18:00:00.000Z',
    verifiedAt: '2026-09-02T18:01:30.000Z',
  }],
}, privateKeyPem);
const rawDocumentsByDataset = Object.fromEntries(BACKEND_DATASETS.map((dataset) => [dataset.name, []]));
rawDocumentsByDataset.organizations = [{
  _id: { $oid: '64b000000000000000000001' },
  organizationId: 'org_cutover_realdb_01',
  name: 'Cutover Real Database Fixture',
  slug: 'cutover-real-database-fixture',
  status: 'active',
  createdAt: { $date: '2026-09-02T18:00:00.000Z' },
  updatedAt: { $date: '2026-09-02T18:00:00.000Z' },
  __v: { $numberInt: '0' },
}];
rawDocumentsByDataset.reviewer_profiles = [{
  _id: { $oid: '64b000000000000000000099' },
  reviewerId: 'reviewer_cutover_realdb_01',
  oxyUserId: 'oxy_cutover_realdb_01',
  state: 'applicant',
  accountActive: true,
  oxyAccountVerified: true,
  isAdult: true,
  suspectedSockPuppet: false,
  riskClusterId: null,
  languages: ['en'],
  categories: ['general'],
  specialistCategories: [],
  maxSensitivityRank: 0,
  consentedSensitiveCategories: [],
  declaredConflictApplications: [],
  // Deliberately omitted: nullable rulesAcceptedAt must canonicalize to SQL NULL.
  available: true,
  dailyReviewLimit: 10,
  trainingCompletedModules: [],
  trainingCompletedAt: null,
  calibrationPassedAt: null,
  calibrationScore: null,
  calibrationAttempts: 0,
  lastCalibrationAt: null,
  reliabilityByCategory: { general: 0.75 },
  completedReviewCount: 0,
  personhoodConfidence: 1,
  samplingKey: 0.5,
  suspendedUntil: null,
  createdAt: { $date: '2026-09-02T18:00:00.000Z' },
  updatedAt: { $date: '2026-09-02T18:00:00.000Z' },
  principalLinks: [],
}];

const evidenceDirectory = mkdtempSync(join(tmpdir(), 'crowdsource-cutover-realdb-'));
const bundleDirectory = join(evidenceDirectory, 'bundle');
const failedBundleDirectory = join(evidenceDirectory, 'failed-bundle');
const failedReceiptPath = join(evidenceDirectory, 'failed-import-receipt.json');
const receiptPath = join(evidenceDirectory, 'import-receipt.json');
const finalManifestPath = join(evidenceDirectory, 'final-manifest.json');
await createSourceBundle({
  outputDirectory: bundleDirectory,
  rawDocumentsByDataset,
  sourceDatabase,
  sourceDatabaseFingerprint: sourceFingerprint,
  capturedAt: '2026-09-02T18:03:00.000Z',
  freezeAttestation: freeze,
  freezePublicKeyPem: publicKeyPem,
});
const invalidRawDocuments = structuredClone(rawDocumentsByDataset);
invalidRawDocuments.organizations.push({
  ...structuredClone(rawDocumentsByDataset.organizations[0]),
  _id: { $oid: '64b000000000000000000004' },
  organizationId: 'org_cutover_realdb_02',
  slug: 'cutover-real-database-invalid',
  status: 'not-a-real-status',
});
await createSourceBundle({
  outputDirectory: failedBundleDirectory,
  rawDocumentsByDataset: invalidRawDocuments,
  sourceDatabase,
  sourceDatabaseFingerprint: sourceFingerprint,
  capturedAt: '2026-09-02T18:03:00.000Z',
  freezeAttestation: freeze,
  freezePublicKeyPem: publicKeyPem,
});

const database = await createPostgresTestDatabase();
let asAdmin;
try {
  const targetDatabase = decodeURIComponent(new URL(database.migratorUrl).pathname.replace(/^\//, ''));
  const targetFingerprint = targetFingerprintForUrl(database.migratorUrl, targetDatabase);
  const adminTargetUrl = new URL(adminUrl);
  adminTargetUrl.pathname = `/${targetDatabase}`;
  asAdmin = postgres(adminTargetUrl.toString(), { max: 1 });

  await assertPostgresTarget(database.asMigrator, targetDatabase);

  const assertCatalogMutationRefused = async (label) => {
    let refused = false;
    try {
      await assertPostgresTarget(database.asMigrator, targetDatabase);
    } catch (error) {
      refused = /PostgreSQL catalog differs/.test(error instanceof Error ? error.message : String(error));
    }
    if (!refused) throw new Error(`${label} passed the exact PostgreSQL catalog preflight.`);
  };

  await database.asMigrator`
    CREATE SCHEMA unexpected_cutover_scope AUTHORIZATION crowdsource_migrator
  `;
  await database.asMigrator`
    CREATE TABLE unexpected_cutover_scope.reports (id text PRIMARY KEY)
  `;
  await database.asMigrator`
    INSERT INTO unexpected_cutover_scope.reports (id) VALUES ('shadow-row')
  `;
  await database.asMigrator`
    GRANT SELECT ON unexpected_cutover_scope.reports TO crowdsource_app
  `;
  await database.asMigrator.begin(async (transaction) => {
    await transaction.unsafe(`SET LOCAL search_path = unexpected_cutover_scope, public`);
    const qualifiedCounts = await countTargetRows(transaction);
    if (qualifiedCounts.reports !== 0) {
      throw new Error('Target counts followed search_path instead of exact public table bindings.');
    }
  });
  await assertCatalogMutationRefused('A migrator-owned external schema, table and ACL');
  await database.asMigrator`DROP TABLE unexpected_cutover_scope.reports`;
  await database.asMigrator`DROP SCHEMA unexpected_cutover_scope`;
  await assertPostgresTarget(database.asMigrator, targetDatabase);

  await asAdmin`CREATE SCHEMA unexpected_foreign_scope AUTHORIZATION CURRENT_USER`;
  await asAdmin`CREATE TABLE unexpected_foreign_scope.unrelated (id text PRIMARY KEY)`;
  await asAdmin`
    ALTER DEFAULT PRIVILEGES IN SCHEMA unexpected_foreign_scope
      GRANT SELECT ON TABLES TO crowdsource_app
  `;
  const foreignOwnedCatalog = await postgresCatalogEvidence(database.asMigrator);
  if (
    !foreignOwnedCatalog.namespaces.some((entry) => entry.name === 'unexpected_foreign_scope') ||
    !foreignOwnedCatalog.objects.some((entry) => (
      entry.schema === 'unexpected_foreign_scope' && entry.name === 'unrelated'
    )) ||
    !foreignOwnedCatalog.defaultPrivileges.some((entry) => (
      entry.schema === 'unexpected_foreign_scope' && entry.grantee === 'crowdsource_app'
    ))
  ) {
    throw new Error('A foreign-owned schema, object or default ACL escaped catalog evidence.');
  }
  await assertCatalogMutationRefused('A foreign-owned external schema, table and default ACL');
  await asAdmin`DROP SCHEMA unexpected_foreign_scope CASCADE`;
  await assertPostgresTarget(database.asMigrator, targetDatabase);

  await database.asMigrator`
    CREATE DOMAIN public.unexpected_cutover_domain AS text COLLATE "C"
      CHECK (VALUE <> '')
  `;
  const customTypeCatalog = await postgresCatalogEvidence(database.asMigrator);
  const customType = customTypeCatalog.types.find(
    (entry) => entry.schema === 'public' && entry.name === 'unexpected_cutover_domain',
  );
  const customDomainConstraint = customTypeCatalog.domainConstraints.find(
    (entry) => entry.schema === 'public' && entry.typeName === 'unexpected_cutover_domain',
  );
  const customTypeGrants = customTypeCatalog.privileges.filter(
    (entry) => entry.objectKind === 'type' && entry.object === 'unexpected_cutover_domain',
  );
  if (
    customType?.owner !== 'crowdsource_migrator' ||
    customType?.collation !== 'pg_catalog."C"' ||
    !Array.isArray(customTypeGrants) ||
    customTypeGrants.length < 1 ||
    !customDomainConstraint?.definition?.startsWith('CHECK')
  ) {
    throw new Error('Custom domain owner, ACL, collation or constraint escaped catalog evidence.');
  }
  await assertCatalogMutationRefused('A custom domain');
  await database.asMigrator`DROP DOMAIN public.unexpected_cutover_domain`;
  await assertPostgresTarget(database.asMigrator, targetDatabase);

  await database.asMigrator`
    CREATE COLLATION public.unexpected_cutover_collation (provider = libc, locale = 'C')
  `;
  const customCollationCatalog = await postgresCatalogEvidence(database.asMigrator);
  if (!customCollationCatalog.collations.some((entry) => (
    entry.schema === 'public' && entry.name === 'unexpected_cutover_collation'
  ))) {
    throw new Error('A standalone custom collation escaped catalog evidence.');
  }
  await assertCatalogMutationRefused('A standalone custom collation');
  await database.asMigrator`DROP COLLATION public.unexpected_cutover_collation`;
  await assertPostgresTarget(database.asMigrator, targetDatabase);

  await database.asMigrator`
    CREATE SEQUENCE public.unexpected_cutover_sequence
      AS integer START WITH 7 INCREMENT BY 3 CACHE 5 CYCLE
  `;
  await database.asMigrator`
    CREATE FUNCTION public.unexpected_cutover_scalar(value integer)
    RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS 'SELECT value + 1'
  `;
  await database.asMigrator`
    CREATE FUNCTION public.unexpected_cutover_trigger()
    RETURNS trigger LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS 'BEGIN RETURN NEW; END'
  `;
  await database.asMigrator`
    CREATE TABLE public.unexpected_cutover_trigger_target (id integer PRIMARY KEY)
  `;
  await database.asMigrator`
    CREATE TRIGGER unexpected_cutover_trigger
    BEFORE INSERT ON public.unexpected_cutover_trigger_target
    FOR EACH ROW EXECUTE FUNCTION public.unexpected_cutover_trigger()
  `;
  await database.asMigrator`
    CREATE AGGREGATE public.unexpected_cutover_sum(integer) (
      SFUNC = pg_catalog.int4pl,
      STYPE = integer,
      INITCOND = '0'
    )
  `;
  const executableCatalog = await postgresCatalogEvidence(database.asMigrator);
  if (
    !executableCatalog.sequences.some((entry) => (
      entry.schema === 'public' &&
      entry.name === 'unexpected_cutover_sequence' &&
      entry.start === '7' &&
      entry.increment === '3' &&
      entry.cache === '5' &&
      entry.cycle === true
    )) ||
    !executableCatalog.functions.some((entry) => (
      entry.schema === 'public' &&
      entry.name === 'unexpected_cutover_scalar' &&
      entry.kind === 'f'
    )) ||
    !executableCatalog.triggers.some((entry) => (
      entry.schema === 'public' &&
      entry.tableName === 'unexpected_cutover_trigger_target' &&
      entry.name === 'unexpected_cutover_trigger' &&
      entry.functionName === 'unexpected_cutover_trigger'
    )) ||
    !executableCatalog.aggregates.some((entry) => (
      entry.schema === 'public' &&
      entry.name === 'unexpected_cutover_sum' &&
      entry.arguments === 'integer'
    ))
  ) {
    throw new Error('A sequence, function, trigger or aggregate escaped catalog evidence.');
  }
  await assertCatalogMutationRefused('A sequence, functions, trigger and aggregate');
  await database.asMigrator`DROP AGGREGATE public.unexpected_cutover_sum(integer)`;
  await database.asMigrator`DROP TABLE public.unexpected_cutover_trigger_target`;
  await database.asMigrator`DROP FUNCTION public.unexpected_cutover_trigger()`;
  await database.asMigrator`DROP FUNCTION public.unexpected_cutover_scalar(integer)`;
  await database.asMigrator`DROP SEQUENCE public.unexpected_cutover_sequence`;
  await assertPostgresTarget(database.asMigrator, targetDatabase);

  if (!/^[a-z0-9_-]{1,63}$/.test(targetDatabase)) {
    throw new Error('Disposable target database name cannot be safely quoted for the settings mutation.');
  }
  await database.asMigrator.unsafe(
    `ALTER ROLE "crowdsource_migrator" IN DATABASE "${targetDatabase}" ` +
    `SET statement_timeout = '5s'`,
  );
  const roleSettingsCatalog = await postgresCatalogEvidence(database.asMigrator);
  if (!roleSettingsCatalog.roleSettings.some((entry) => (
    entry.database === 'current_database' &&
    entry.role === 'crowdsource_migrator' &&
    entry.setting === 'statement_timeout=5s'
  ))) {
    throw new Error('Database-specific CrowdSource role settings escaped catalog evidence.');
  }
  await assertCatalogMutationRefused('A database-specific migrator role setting');
  await database.asMigrator.unsafe(
    `ALTER ROLE "crowdsource_migrator" IN DATABASE "${targetDatabase}" RESET statement_timeout`,
  );
  await assertPostgresTarget(database.asMigrator, targetDatabase);

  await database.asMigrator`ALTER TABLE reports NO FORCE ROW LEVEL SECURITY`;
  let missingForceRlsRefused = false;
  try {
    await assertPostgresTarget(database.asMigrator, targetDatabase);
  } catch (error) {
    missingForceRlsRefused = /PostgreSQL catalog differs/.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!missingForceRlsRefused) throw new Error('A reports table without FORCE RLS passed preflight.');
  await database.asMigrator`ALTER TABLE reports FORCE ROW LEVEL SECURITY`;
  await assertPostgresTarget(database.asMigrator, targetDatabase);

  const [reviewerIndex] = await database.asMigrator`
    SELECT pg_get_indexdef(index_relation.oid, 0, true) AS definition
    FROM pg_class index_relation
    JOIN pg_namespace namespace ON namespace.oid = index_relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND index_relation.relname = 'reviewer_profiles_oxy_user_id_key'
  `;
  if (typeof reviewerIndex?.definition !== 'string') {
    throw new Error('The reviewer profile identity index fixture is absent.');
  }
  await database.asMigrator`DROP INDEX reviewer_profiles_oxy_user_id_key`;
  let missingUniqueIndexRefused = false;
  try {
    await assertPostgresTarget(database.asMigrator, targetDatabase);
  } catch (error) {
    missingUniqueIndexRefused = /PostgreSQL catalog differs/.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!missingUniqueIndexRefused) {
    throw new Error('A target without reviewer_profiles_oxy_user_id_key passed preflight.');
  }
  await database.asMigrator.unsafe(reviewerIndex.definition);
  await assertPostgresTarget(database.asMigrator, targetDatabase);

  const [ledgerEntry] = await database.asMigrator`
    SELECT id, hash, created_at::text AS "createdAt"
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at, id
    LIMIT 1
  `;
  if (
    !Number.isSafeInteger(ledgerEntry?.id) ||
    typeof ledgerEntry?.hash !== 'string' ||
    typeof ledgerEntry?.createdAt !== 'string'
  ) {
    throw new Error('The migration ledger fixture is malformed.');
  }
  await database.asMigrator`
    UPDATE drizzle.__drizzle_migrations
    SET hash = ${'0'.repeat(64)}
    WHERE id = ${ledgerEntry.id}
  `;
  const [mutatedLedgerEntry] = await database.asMigrator`
    SELECT hash, created_at::text AS "createdAt"
    FROM drizzle.__drizzle_migrations
    WHERE id = ${ledgerEntry.id}
  `;
  if (mutatedLedgerEntry?.createdAt !== ledgerEntry.createdAt) {
    throw new Error('Ledger mutation test changed created_at and no longer models the reported drift.');
  }
  let corruptLedgerRefused = false;
  try {
    await assertPostgresTarget(database.asMigrator, targetDatabase);
  } catch (error) {
    corruptLedgerRefused = /migration ledger hashes and timestamps/.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!corruptLedgerRefused) {
    throw new Error('A corrupt migration hash with unchanged created_at passed preflight.');
  }
  await database.asMigrator`
    UPDATE drizzle.__drizzle_migrations
    SET hash = ${ledgerEntry.hash}
    WHERE id = ${ledgerEntry.id}
  `;
  await assertPostgresTarget(database.asMigrator, targetDatabase);

  await database.asMigrator`
    CREATE TABLE rogue_cutover_table (id text PRIMARY KEY)
  `;
  let extraTableRefused = false;
  try {
    await importPostgres({
      bundleDirectory,
      receiptPath,
      connectionUrl: database.migratorUrl,
      targetDatabase,
      expectedTargetFingerprint: targetFingerprint,
      phase: 'all',
    });
  } catch (error) {
    extraTableRefused = /PostgreSQL catalog differs/.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!extraTableRefused) throw new Error('An extra target table escaped the exact schema census.');
  await database.asMigrator`
    DROP TABLE rogue_cutover_table
  `;

  let failedImportRefused = false;
  try {
    await importPostgres({
      bundleDirectory: failedBundleDirectory,
      receiptPath: failedReceiptPath,
      connectionUrl: database.migratorUrl,
      targetDatabase,
      expectedTargetFingerprint: targetFingerprint,
      phase: 'all',
    });
  } catch (error) {
    failedImportRefused = /organizations_status_check|violates check constraint/.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!failedImportRefused) throw new Error('Invalid target row did not fail inside the import transaction.');
  const [afterFailure] = await database.asMigrator`
    SELECT count(*)::integer AS count FROM organizations
  `;
  if (afterFailure?.count !== 0) throw new Error('Failed cutover import left a partial PostgreSQL row.');

  const first = await importPostgres({
    bundleDirectory,
    receiptPath,
    connectionUrl: database.migratorUrl,
    targetDatabase,
    expectedTargetFingerprint: targetFingerprint,
    phase: 'all',
  });
  if (first.idempotent) throw new Error('First cutover import incorrectly reported an idempotent retry.');
  const [stored] = await database.asMigrator`
    SELECT organization_id AS "organizationId", name
    FROM organizations
  `;
  if (
    stored?.organizationId !== 'org_cutover_realdb_01' ||
    stored?.name !== 'Cutover Real Database Fixture'
  ) {
    throw new Error('Real PostgreSQL import did not preserve the fixture row exactly.');
  }

  const retry = await importPostgres({
    bundleDirectory,
    receiptPath,
    connectionUrl: database.migratorUrl,
    targetDatabase,
    expectedTargetFingerprint: targetFingerprint,
    phase: 'all',
  });
  if (!retry.idempotent) throw new Error('Exact committed retry was not handled idempotently.');

  const manifest = await reexportPostgres({
    bundleDirectory,
    receiptPath,
    outputManifestPath: finalManifestPath,
    connectionUrl: database.migratorUrl,
    targetDatabase,
    expectedTargetFingerprint: targetFingerprint,
    phase: 'all',
  });
  const violations = finalManifestViolations(manifest);
  if (violations.length > 0) throw new Error(`Real PostgreSQL manifest failed: ${violations.join('; ')}`);
  await verifyFinalManifestEvidence({
    manifest,
    bundleDirectory,
    receiptPath,
  });

  await database.asMigrator`
    UPDATE organizations
    SET name = 'Mutated after import'
    WHERE organization_id = 'org_cutover_realdb_01'
  `;
  let mutationRefused = false;
  try {
    await importPostgres({
      bundleDirectory,
      receiptPath,
      connectionUrl: database.migratorUrl,
      targetDatabase,
      expectedTargetFingerprint: targetFingerprint,
      phase: 'all',
    });
  } catch (error) {
    mutationRefused = /reconciliation refused|canonical evidence differs/.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!mutationRefused) throw new Error('A mutated non-empty target passed the idempotent retry guard.');
} finally {
  if (asAdmin !== undefined) await asAdmin.end();
  await database.close();
}

process.stdout.write(
  'Real PostgreSQL cutover exact catalog, foreign-owned schema/default-ACL/collation/type/sequence/function/trigger/aggregate/setting/RLS/index/ledger mutations, public bindings, rollback, import, committed retry, re-export and target-mutation refusal passed.\n',
);
