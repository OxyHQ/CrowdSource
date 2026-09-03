#!/usr/bin/env bun

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  BACKEND_DATASETS,
  ARCHIVE_SOURCE_KIND,
  EXPECTED_POSTGRES_CATALOG_SHA256,
  FINAL_BACKUP_RECOVERY_PROFILE,
  FREEZE_FORMAT,
  RECEIPT_FORMAT,
  allTableMetadata,
  assertMigrationPhase,
  assertTargetCountsEmpty,
  atomicEvidenceWrite,
  archiveSourceFingerprint,
  buildTargetPlan,
  canonicalJson,
  canonicalizeSourceDocument,
  createSourceBundle,
  databaseFingerprint,
  finalManifestViolations,
  loadAndVerifySourceBundle,
  receiptIdentity,
  sha256,
  signFreezeAttestation,
  verifyFinalManifestEvidence,
  verifyFreezeAttestation,
  validateRelationships,
} from './crowdsource-backend-cutover-lib.mjs';

function expectFailure(action, pattern) {
  return Promise.resolve()
    .then(action)
    .then(() => {
      throw new Error(`Expected refusal matching ${pattern}.`);
    }, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!pattern.test(message)) throw new Error(`Wrong refusal '${message}', expected ${pattern}.`);
    });
}

const sourceDatabase = 'crowdsource-production';
const sourceUrl = `mongodb://cutover_reader:not-recorded@db.internal:27017/${sourceDatabase}?replicaSet=rs0`;
const sourceFingerprint = databaseFingerprint(sourceUrl, sourceDatabase, 'mongodb');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const unsignedFreeze = {
  format: FREEZE_FORMAT,
  sourceDatabase,
  sourceDatabaseFingerprint: sourceFingerprint,
  changeId: 'CHG-20260903-CROWDSOURCE',
  writesFrozen: true,
  observedFrom: '2026-09-03T00:01:00.000Z',
  observedUntil: '2026-09-03T00:02:00.000Z',
  nonce: randomBytes(32).toString('base64'),
  writers: [
    {
      id: 'crowdsource-api-ecs',
      stoppedAt: '2026-09-03T00:00:00.000Z',
      verifiedAt: '2026-09-03T00:01:30.000Z',
    },
  ],
};
const freeze = signFreezeAttestation(unsignedFreeze, privateKeyPem);
verifyFreezeAttestation(freeze, publicKeyPem, {
  databaseName: sourceDatabase,
  databaseFingerprint: sourceFingerprint,
});

const rawDocumentsByDataset = Object.fromEntries(BACKEND_DATASETS.map((dataset) => [dataset.name, []]));
rawDocumentsByDataset.organizations = [
  {
    _id: { $oid: '64b000000000000000000001' },
    organizationId: 'org_fixture_01',
    name: 'Fixture Organization',
    slug: 'fixture-organization',
    status: 'active',
    createdAt: { $date: '2026-09-03T00:00:00.000Z' },
    updatedAt: { $date: '2026-09-03T00:00:00.000Z' },
    __v: { $numberInt: '0' },
  },
];
const parent = mkdtempSync(join(tmpdir(), 'crowdsource-cutover-contract-'));
const bundle = join(parent, 'bundle');
await createSourceBundle({
  outputDirectory: bundle,
  rawDocumentsByDataset,
  sourceDatabase,
  sourceDatabaseFingerprint: sourceFingerprint,
  capturedAt: '2026-09-03T00:03:00.000Z',
  freezeAttestation: freeze,
  freezePublicKeyPem: publicKeyPem,
});
const loaded = await loadAndVerifySourceBundle(bundle);
if (loaded.manifest.datasets.length !== 26) throw new Error('Source bundle did not preserve 26 datasets.');
if (loaded.manifest.datasets.flatMap((dataset) => dataset.tables).length !== 27) {
  throw new Error('Source bundle did not preserve 27 explicit target tables.');
}
const plan = await buildTargetPlan(loaded.canonicalRowsByDataset);
if (plan.organizations[0]?.organizationId !== 'org_fixture_01') {
  throw new Error('Source domain identifier was not preserved in the target plan.');
}

const membership = await canonicalizeSourceDocument('organization_members', {
  _id: { $oid: '64b000000000000000000002' },
  organizationId: 'org_fixture_01',
  oxyUserId: 'oxy_fixture_01',
  role: 'owner',
  status: 'active',
  invitedByOxyUserId: null,
  revokedAt: null,
  createdAt: { $date: '2026-09-03T00:00:00.000Z' },
  updatedAt: { $date: '2026-09-03T00:00:00.000Z' },
});
if (membership.membershipId !== '64b000000000000000000002') {
  throw new Error('Mongo organization member _id was not preserved exactly.');
}
const relation = await canonicalizeSourceDocument('reviewer_relations', {
  _id: { $oid: '64b000000000000000000003' },
  reviewerId: 'reviewer_fixture_01',
  applicationId: 'app_fixture_01',
  externalPrincipalId: 'external_fixture_01',
  source: 'declared',
  createdAt: { $date: '2026-09-03T00:00:00.000Z' },
  updatedAt: { $date: '2026-09-03T00:00:00.000Z' },
});
if (relation.reviewerRelationId !== '64b000000000000000000003') {
  throw new Error('Mongo reviewer relation _id was not preserved exactly.');
}

const targetDatabase = 'crowdsource';
const targetDatabaseFingerprint = sha256('independent-target-identity');
const receiptPath = join(parent, 'receipt.json');
const receipt = {
  format: RECEIPT_FORMAT,
  schemaVersion: 1,
  state: 'committed',
  migrationPhase: 'all',
  emptyBeforeImport: true,
  emptyCheckedAt: '2026-09-03T00:03:30.000Z',
  sourceManifestSha256: loaded.manifestSha256,
  sourceDatabaseFingerprint: sourceFingerprint,
  targetDatabase,
  targetDatabaseFingerprint,
  migrationJournalSha256: loaded.manifest.migrationJournalSha256,
  importIdentity: receiptIdentity({
    sourceManifestSha256: loaded.manifestSha256,
    targetDatabaseFingerprint,
    journalSha256: loaded.manifest.migrationJournalSha256,
  }),
  committedAt: '2026-09-03T00:03:45.000Z',
};
atomicEvidenceWrite(receiptPath, receipt);

const finalManifest = structuredClone(loaded.manifest);
finalManifest.target = {
  databaseName: targetDatabase,
  databaseFingerprint: targetDatabaseFingerprint,
  checkedAt: '2026-09-03T00:04:00.000Z',
  migratorRole: 'crowdsource_migrator',
  emptyBeforeImport: true,
  isolationLevel: 'serializable',
  schemaAndOwnerVerified: true,
  migrationLedgerVerified: true,
  postgresCatalogSha256: EXPECTED_POSTGRES_CATALOG_SHA256,
  totalCount: loaded.manifest.source.totalCount,
  importReceiptSha256: sha256(`${canonicalJson(receipt)}\n`),
};
for (const dataset of finalManifest.datasets) {
  dataset.targetCount = dataset.sourceCount;
  dataset.targetSha256 = dataset.sourceSha256;
  dataset.targetIdentitySha256 = dataset.sourceIdentitySha256;
  for (const table of dataset.tables) {
    table.targetCount = table.sourceCount;
    table.targetSha256 = table.sourceSha256;
    table.targetIdentitySha256 = table.sourceIdentitySha256;
  }
}
if (finalManifestViolations(finalManifest).length !== 0) {
  throw new Error(`Valid final manifest was refused: ${finalManifestViolations(finalManifest).join('; ')}`);
}

const archiveFinalManifest = structuredClone(finalManifest);
archiveFinalManifest.schemaVersion = 2;
const emptyEvidenceSha256 = sha256('');
for (const dataset of archiveFinalManifest.datasets) {
  const recoveredCount = FINAL_BACKUP_RECOVERY_PROFILE.expectedCounts[dataset.name];
  const recoveredSha256 = recoveredCount === 0
    ? emptyEvidenceSha256
    : sha256(`archive-${dataset.name}-canonical-rows`);
  const recoveredIdentitySha256 = recoveredCount === 0
    ? emptyEvidenceSha256
    : sha256(`archive-${dataset.name}-identities`);
  dataset.sourceCount = recoveredCount;
  dataset.sourceSha256 = recoveredSha256;
  dataset.sourceIdentitySha256 = recoveredIdentitySha256;
  dataset.targetCount = recoveredCount;
  dataset.targetSha256 = recoveredSha256;
  dataset.targetIdentitySha256 = recoveredIdentitySha256;
  for (const table of dataset.tables) {
    const tableCount = dataset.name === 'reviewer_profiles' && table.name === 'reviewer_profiles' ? 2 : 0;
    const tableSha256 = tableCount === 0
      ? emptyEvidenceSha256
      : sha256(`archive-${table.name}-canonical-rows`);
    const tableIdentitySha256 = tableCount === 0
      ? emptyEvidenceSha256
      : sha256(`archive-${table.name}-identities`);
    table.sourceCount = tableCount;
    table.sourceSha256 = tableSha256;
    table.sourceIdentitySha256 = tableIdentitySha256;
    table.targetCount = tableCount;
    table.targetSha256 = tableSha256;
    table.targetIdentitySha256 = tableIdentitySha256;
  }
}
archiveFinalManifest.source = {
  evidenceKind: ARCHIVE_SOURCE_KIND,
  databaseName: FINAL_BACKUP_RECOVERY_PROFILE.databaseName,
  databaseFingerprint: archiveSourceFingerprint(FINAL_BACKUP_RECOVERY_PROFILE),
  capturedAt: FINAL_BACKUP_RECOVERY_PROFILE.objectLastModified,
  sourceRetired: true,
  archiveFile: 'source.archive.gz',
  archiveObjectUri: FINAL_BACKUP_RECOVERY_PROFILE.objectUri,
  archiveObjectVersionId: FINAL_BACKUP_RECOVERY_PROFILE.objectVersionId,
  archiveSha256: FINAL_BACKUP_RECOVERY_PROFILE.archiveSha256,
  archiveBytes: FINAL_BACKUP_RECOVERY_PROFILE.archiveBytes,
  archiveCreatedByMongoVersion: FINAL_BACKUP_RECOVERY_PROFILE.archiveCreatedByMongoVersion,
  archiveCensusFile: 'archive-census.json',
  archiveCensusSha256: sha256('archive-census-fixture'),
  recoveryImage: FINAL_BACKUP_RECOVERY_PROFILE.recoveryImage,
  networkIsolatedRestore: true,
  exactNamespaceCensus: true,
  totalCount: 2,
};
archiveFinalManifest.target.totalCount = 2;
if (finalManifestViolations(archiveFinalManifest).length !== 0) {
  throw new Error(
    `Valid archive final manifest metadata was refused: ${finalManifestViolations(archiveFinalManifest).join('; ')}`,
  );
}
const changedArchive = structuredClone(archiveFinalManifest);
changedArchive.source.archiveSha256 = sha256('similar-but-wrong-archive');
if (!/pinned final backup profile/.test(finalManifestViolations(changedArchive).join('\n'))) {
  throw new Error('Final manifest accepted an archive outside the pinned recovery profile.');
}
const changedArchiveVersion = structuredClone(archiveFinalManifest);
changedArchiveVersion.source.archiveObjectVersionId = 'similar-but-wrong-version';
if (!/pinned final backup profile/.test(finalManifestViolations(changedArchiveVersion).join('\n'))) {
  throw new Error('Final manifest accepted a different S3 object version.');
}
await verifyFinalManifestEvidence({
  manifest: finalManifest,
  bundleDirectory: bundle,
  receiptPath,
});

function mustCatchManifest(mutator, pattern) {
  const changed = structuredClone(finalManifest);
  mutator(changed);
  const violations = finalManifestViolations(changed).join('\n');
  if (!pattern.test(violations)) throw new Error(`Manifest mutation escaped: ${pattern}; got '${violations}'.`);
}

mustCatchManifest((changed) => { changed.source.writesFrozen = false; }, /not frozen/);
mustCatchManifest((changed) => { changed.target.emptyBeforeImport = false; }, /not proven empty/);
mustCatchManifest(
  (changed) => { changed.target.postgresCatalogSha256 = sha256('different-postgres-catalog'); },
  /transaction\/schema\/ledger evidence is invalid/,
);
mustCatchManifest((changed) => { changed.datasets[10].targetCount += 1; }, /canonical evidence differs/);
mustCatchManifest(
  (changed) => { changed.datasets[10].targetSha256 = sha256('mutated-domain-bytes'); },
  /canonical evidence differs/,
);
mustCatchManifest(
  (changed) => { changed.datasets[10].tables[0].targetIdentitySha256 = sha256('mutated-id'); },
  /Table 'organizations' evidence differs/,
);
mustCatchManifest(
  (changed) => { changed.datasets[10].targetTables = ['applications']; },
  /wrong target table binding/,
);
mustCatchManifest(
  (changed) => { changed.target.databaseFingerprint = `sha256:${'a'.repeat(64)}`; },
  /placeholder digest/,
);
mustCatchManifest((changed) => { changed.datasets.pop(); }, /exactly 26 datasets/);

const wrongReceiptManifest = structuredClone(finalManifest);
wrongReceiptManifest.target.importReceiptSha256 = sha256('different-committed-receipt');
await expectFailure(
  () => verifyFinalManifestEvidence({
    manifest: wrongReceiptManifest,
    bundleDirectory: bundle,
    receiptPath,
  }),
  /receipt digest differs/,
);
const detachedSourceManifest = structuredClone(finalManifest);
detachedSourceManifest.datasets[10].sourceSha256 = sha256('detached-source-evidence');
detachedSourceManifest.datasets[10].targetSha256 = detachedSourceManifest.datasets[10].sourceSha256;
await expectFailure(
  () => verifyFinalManifestEvidence({
    manifest: detachedSourceManifest,
    bundleDirectory: bundle,
    receiptPath,
  }),
  /source evidence differs from the signed source bundle/,
);

await expectFailure(
  () => verifyFreezeAttestation({ ...freeze, writesFrozen: false }, publicKeyPem, {
    databaseName: sourceDatabase,
    databaseFingerprint: sourceFingerprint,
  }),
  /does not freeze writes/,
);
await expectFailure(
  () => verifyFreezeAttestation({ ...freeze, signature: freeze.signature.slice(0, -4) + 'AAAA' }, publicKeyPem, {
    databaseName: sourceDatabase,
    databaseFingerprint: sourceFingerprint,
  }),
  /signature is invalid/,
);
const staleWriterFreeze = signFreezeAttestation({
  ...unsignedFreeze,
  writers: [{
    ...unsignedFreeze.writers[0],
    verifiedAt: '2026-09-02T23:59:59.000Z',
  }],
}, privateKeyPem);
await expectFailure(
  () => verifyFreezeAttestation(staleWriterFreeze, publicKeyPem, {
    databaseName: sourceDatabase,
    databaseFingerprint: sourceFingerprint,
  }),
  /verified during the evidence window/,
);
await expectFailure(() => assertMigrationPhase('pre'), /requires --phase=all/);
const metadata = await allTableMetadata();
const emptyCounts = Object.fromEntries(metadata.map((table) => [table.tableKey, 0]));
assertTargetCountsEmpty(emptyCounts);
await expectFailure(
  () => assertTargetCountsEmpty({ ...emptyCounts, organizations: 1 }),
  /organizations.*not empty/,
);
await expectFailure(
  () => canonicalizeSourceDocument('organizations', {
    ...rawDocumentsByDataset.organizations[0],
    silentlyDropped: true,
  }),
  /unknown field 'silentlyDropped'/,
);
await expectFailure(
  () => canonicalizeSourceDocument('organizations', {
    ...rawDocumentsByDataset.organizations[0],
    organizationId: undefined,
  }),
  /no exact identity field 'organizationId'/,
);

const brokenReferences = structuredClone(loaded.canonicalRowsByDataset);
brokenReferences.applications = [{
  applicationId: 'app_fixture_01',
  organizationId: 'org_absent',
  name: 'Broken fixture',
  status: 'active',
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
}];
await expectFailure(() => buildTargetPlan(brokenReferences), /references an absent identifier/);

const relationshipPlan = structuredClone(plan);
relationshipPlan.applications.push({
  applicationId: 'app_fixture_01',
  organizationId: 'org_fixture_01',
});
relationshipPlan.applicationCredentials.push({
  credentialId: 'credential_fixture_01',
  applicationId: 'app_fixture_01',
  organizationId: 'org_fixture_01',
});
relationshipPlan.cases.push({
  caseId: 'case_fixture_01',
  applicationId: 'app_fixture_01',
  organizationId: 'org_fixture_01',
});
relationshipPlan.decisions.push({
  decisionId: 'decision_fixture_01',
  caseId: 'case_fixture_01',
  revision: 1,
  supersedesDecisionId: null,
  applicationId: 'app_fixture_01',
  organizationId: 'org_fixture_01',
});
relationshipPlan.appeals.push({
  appealId: 'appeal_fixture_01',
  caseId: 'case_fixture_01',
  supersededRevision: 1,
  supersededDecisionId: 'decision_fixture_01',
  filedByCredentialId: 'credential_fixture_01',
  applicationId: 'app_fixture_01',
  organizationId: 'org_fixture_01',
});
relationshipPlan.outboxEvents.push({
  eventId: 'event_fixture_01',
  payload: { caseId: 'case_fixture_01', appealId: 'appeal_fixture_01' },
  applicationId: 'app_fixture_01',
  organizationId: 'org_fixture_01',
});
validateRelationships(relationshipPlan);
const wrongAppealTenant = structuredClone(relationshipPlan);
wrongAppealTenant.appeals[0].organizationId = 'org_absent';
await expectFailure(
  () => validateRelationships(wrongAppealTenant),
  /appeals\[0\].*absent identifier/,
);
const wrongOutboxReference = structuredClone(relationshipPlan);
wrongOutboxReference.outboxEvents[0].payload.caseId = 'case_absent';
await expectFailure(
  () => validateRelationships(wrongOutboxReference),
  /outboxEvents\[0\]\.payload\.caseId references an absent identifier/,
);
const unknownOutboxPayload = structuredClone(relationshipPlan);
unknownOutboxPayload.outboxEvents[0].payload.userText = 'must never be copied';
await expectFailure(
  () => validateRelationships(unknownOutboxPayload),
  /payload contains unknown field 'userText'/,
);

const emptyParent = mkdtempSync(join(tmpdir(), 'crowdsource-cutover-empty-'));
await expectFailure(
  () => createSourceBundle({
    outputDirectory: join(emptyParent, 'bundle'),
    rawDocumentsByDataset: Object.fromEntries(BACKEND_DATASETS.map((dataset) => [dataset.name, []])),
    sourceDatabase,
    sourceDatabaseFingerprint: sourceFingerprint,
    capturedAt: '2026-09-03T00:03:00.000Z',
    freezeAttestation: freeze,
    freezePublicKeyPem: publicKeyPem,
  }),
  /Source export is empty/,
);

const packageManifest = readFileSync(new URL('../packages/backend/package.json', import.meta.url), 'utf8');
if (/"(?:mongodb|mongoose)"\s*:/.test(packageManifest)) {
  throw new Error('The production backend acquired a MongoDB driver dependency.');
}

const cutoverLibrary = readFileSync(
  new URL('./crowdsource-backend-cutover-lib.mjs', import.meta.url),
  'utf8',
);
const atomicWriteStart = cutoverLibrary.indexOf('export function atomicEvidenceWrite');
const atomicWriteEnd = cutoverLibrary.indexOf('\nexport function readJsonFile', atomicWriteStart);
const atomicWriteSource = atomicWriteStart < 0 || atomicWriteEnd < 0
  ? ''
  : cutoverLibrary.slice(atomicWriteStart, atomicWriteEnd);
if (!/fsyncSync\(descriptor\)/.test(atomicWriteSource) || !/fsyncSync\(parentDescriptor\)/.test(atomicWriteSource)) {
  throw new Error('Import receipt writes are atomic but not durable across a machine restart.');
}

const cutoverEntrypoint = new URL('./crowdsource-backend-cutover.mjs', import.meta.url);
const cutoverEntrypointSource = readFileSync(cutoverEntrypoint, 'utf8');
if (
  /fingerprint-source|fingerprint-freeze-key|sign-freeze|verify-freeze|export-mongo|mongosh/.test(
    cutoverEntrypointSource,
  ) ||
  existsSync(new URL('./crowdsource-backend-export-mongo.mongosh.js', import.meta.url))
) {
  throw new Error('The PostgreSQL cutover runtime still carries the retired live-Mongo exporter.');
}
const credentialEnvironment = { ...process.env };
delete credentialEnvironment.CROWDSOURCE_CUTOVER_SOURCE_URL;
delete credentialEnvironment.CROWDSOURCE_CUTOVER_POSTGRES_URL;
const targetConnectionUrl = 'postgresql://cutover_migrator:not-recorded@db.internal:5432/crowdsource?sslmode=require';
const targetCliFingerprint = databaseFingerprint(targetConnectionUrl, targetDatabase, 'postgresql');
const fingerprintProcess = spawnSync(
  'bun',
  [cutoverEntrypoint.pathname, 'fingerprint-target', `--target-database=${targetDatabase}`],
  {
    input: targetConnectionUrl,
    encoding: 'utf8',
    env: credentialEnvironment,
  },
);
if (fingerprintProcess.status !== 0 || fingerprintProcess.stdout.trim() !== targetCliFingerprint) {
  throw new Error(`Standard-input target fingerprint failed: ${fingerprintProcess.stderr}`);
}

const legacyEnvironmentProcess = spawnSync(
  'bun',
  [cutoverEntrypoint.pathname, 'fingerprint-target', `--target-database=${targetDatabase}`],
  {
    input: targetConnectionUrl,
    encoding: 'utf8',
    env: { ...credentialEnvironment, CROWDSOURCE_CUTOVER_POSTGRES_URL: targetConnectionUrl },
  },
);
if (legacyEnvironmentProcess.status === 0 || !/never through environment variables/.test(legacyEnvironmentProcess.stderr)) {
  throw new Error('The legacy source-credential environment path was not refused.');
}
if (`${legacyEnvironmentProcess.stdout}${legacyEnvironmentProcess.stderr}`.includes(targetConnectionUrl)) {
  throw new Error('A refused environment credential was emitted in process output.');
}

const multilineCredential = `${targetConnectionUrl}\nsecond-value`;
const malformedInputProcess = spawnSync(
  'bun',
  [cutoverEntrypoint.pathname, 'fingerprint-target', `--target-database=${targetDatabase}`],
  {
    input: multilineCredential,
    encoding: 'utf8',
    env: credentialEnvironment,
  },
);
if (malformedInputProcess.status === 0 || !/exactly one database connection URL/.test(malformedInputProcess.stderr)) {
  throw new Error('A multiline source credential was not refused.');
}
if (`${malformedInputProcess.stdout}${malformedInputProcess.stderr}`.includes(targetConnectionUrl)) {
  throw new Error('A malformed standard-input credential was emitted in process output.');
}

const dockerfile = readFileSync(new URL('../packages/backend/Dockerfile', import.meta.url), 'utf8');
if (/COPY[^\n]*crowdsource-backend-export-mongo\.mongosh\.js/.test(dockerfile)) {
  throw new Error('The migration-only Mongo exporter was copied into the production runtime image.');
}
for (const filename of [
  'crowdsource-backend-cutover.mjs',
  'crowdsource-backend-cutover-lib.mjs',
  'crowdsource-backend-cutover-postgres.mjs',
]) {
  if (!dockerfile.includes(`COPY --from=builder /app/scripts/${filename} scripts/`)) {
    throw new Error(`The guarded PostgreSQL cutover runtime omitted '${filename}'.`);
  }
}

process.stdout.write(
  'Backend cutover contract catches count, digest, ID, freeze, target, phase, empty-control, privilege, runtime-driver and retired-live-export mutations.\n',
);
