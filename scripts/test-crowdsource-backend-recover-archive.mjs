#!/usr/bin/env bun

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARCHIVE_CENSUS_FORMAT,
  BACKEND_DATASETS,
  FINAL_BACKUP_RECOVERY_PROFILE,
  archiveSourceFingerprint,
  assertMongoRecoveryKernelSupported,
  canonicalJson,
  canonicalRowsFromTarget,
  canonicalizeSourceDocument,
  sha256,
  targetRowsForDataset,
  validateArchiveRecoveryEvidence,
} from './crowdsource-backend-cutover-lib.mjs';

function expectFailure(action, pattern) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) throw new Error(`Wrong refusal '${message}', expected ${pattern}.`);
    return;
  }
  throw new Error(`Expected refusal matching ${pattern}.`);
}

const expectedProfile = {
  objectUri: 's3://evidence.invalid/final.archive.gz',
  objectVersionId: 'fixtureVersionId_00000001',
  databaseName: 'crowdsource-production',
  archiveSha256: sha256('fixture-archive'),
  archiveBytes: Buffer.byteLength('fixture-archive'),
  objectLastModified: '2026-08-10T08:26:45.000Z',
  archiveCreatedByMongoVersion: '8.2.11',
  recoveryImage: `mongo@sha256:${'ab'.repeat(32)}`,
  expectedCounts: Object.fromEntries(
    BACKEND_DATASETS.map((dataset) => [dataset.name, dataset.name === 'reviewer_profiles' ? 2 : 0]),
  ),
};
const parent = mkdtempSync(join(tmpdir(), 'crowdsource-archive-evidence-'));
const archive = join(parent, 'source.archive.gz');
writeFileSync(archive, 'fixture-archive', { mode: 0o600 });
const census = {
  format: ARCHIVE_CENSUS_FORMAT,
  databaseName: expectedProfile.databaseName,
  collections: BACKEND_DATASETS.map((dataset) => ({
    name: dataset.name,
    count: expectedProfile.expectedCounts[dataset.name],
  })),
};

const verified = validateArchiveRecoveryEvidence({ archivePath: archive, census, profile: expectedProfile });
if (verified.totalCount !== 2 || verified.databaseFingerprint !== archiveSourceFingerprint(expectedProfile)) {
  throw new Error('Valid archive evidence did not produce its exact count/fingerprint.');
}
const verifiedBytes = validateArchiveRecoveryEvidence({
  archiveBytes: readFileSync(archive),
  census,
  profile: expectedProfile,
});
if (verifiedBytes.archiveSha256 !== verified.archiveSha256) {
  throw new Error('One-read archive evidence differs from path verification.');
}
if (
  archiveSourceFingerprint({ ...expectedProfile, objectVersionId: 'fixtureVersionId_00000002' }) ===
  archiveSourceFingerprint(expectedProfile)
) {
  throw new Error('Archive source fingerprint does not bind the exact S3 VersionId.');
}

expectFailure(
  () => validateArchiveRecoveryEvidence({
    archivePath: archive,
    census,
    profile: { ...expectedProfile, archiveSha256: sha256('different') },
  }),
  /SHA-256 differs/,
);
expectFailure(
  () => validateArchiveRecoveryEvidence({
    archivePath: archive,
    census: { ...census, databaseName: 'crowdsource-similar' },
    profile: expectedProfile,
  }),
  /different source/,
);
const missingCollection = structuredClone(census);
missingCollection.collections.pop();
expectFailure(
  () => validateArchiveRecoveryEvidence({ archivePath: archive, census: missingCollection, profile: expectedProfile }),
  /exactly 26 collections/,
);
const reordered = structuredClone(census);
[reordered.collections[0], reordered.collections[1]] = [reordered.collections[1], reordered.collections[0]];
expectFailure(
  () => validateArchiveRecoveryEvidence({ archivePath: archive, census: reordered, profile: expectedProfile }),
  /collection position 0/,
);
const countChanged = structuredClone(census);
countChanged.collections.find((entry) => entry.name === 'reviewer_profiles').count = 1;
expectFailure(
  () => validateArchiveRecoveryEvidence({ archivePath: archive, census: countChanged, profile: expectedProfile }),
  /differs from the final backup census/,
);

if (
  FINAL_BACKUP_RECOVERY_PROFILE.databaseName !== 'crowdsource-production' ||
  FINAL_BACKUP_RECOVERY_PROFILE.objectVersionId !== 'blYwlJUWMzs2QshDbwQ3JJbeMkmFcXBb' ||
  FINAL_BACKUP_RECOVERY_PROFILE.archiveSha256 !==
    'sha256:4417e03de8c98d55637e4d5aac8462414c98f2b7191dd3309ab9af11bf25a994' ||
  FINAL_BACKUP_RECOVERY_PROFILE.archiveBytes !== 3728 ||
  FINAL_BACKUP_RECOVERY_PROFILE.archiveCreatedByMongoVersion !== '8.2.11' ||
  FINAL_BACKUP_RECOVERY_PROFILE.recoveryImage !==
    'mongo@sha256:951c2ff9fc6bdb6cb89b1dfea4a0e8ae3ee4fb287c0bf579b2bba54c7803f75d' ||
  FINAL_BACKUP_RECOVERY_PROFILE.expectedCounts.reviewer_profiles !== 2 ||
  Object.values(FINAL_BACKUP_RECOVERY_PROFILE.expectedCounts).reduce((sum, count) => sum + count, 0) !== 2
) {
  throw new Error('Canonical final-backup identity/count profile drifted.');
}

assertMongoRecoveryKernelSupported('6.18.12-supported');
assertMongoRecoveryKernelSupported('7.0.14-supported');
for (const affectedKernel of ['6.19.0', '6.20.1', '7.0.13']) {
  expectFailure(
    () => assertMongoRecoveryKernelSupported(affectedKernel),
    /MongoDB 8\.2\.11 recovery is unsupported/,
  );
}

const reviewerWithOmittedNullableField = await canonicalizeSourceDocument('reviewer_profiles', {
  _id: { $oid: '64b000000000000000000099' },
  reviewerId: 'reviewer_archive_fixture',
  oxyUserId: 'oxy_archive_fixture',
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
  available: true,
  dailyReviewLimit: 10,
  trainingCompletedModules: [],
  trainingCompletedAt: null,
  calibrationPassedAt: null,
  calibrationScore: null,
  calibrationAttempts: 0,
  lastCalibrationAt: null,
  reliabilityByCategory: {},
  completedReviewCount: 0,
  personhoodConfidence: 1,
  samplingKey: 0.5,
  suspendedUntil: null,
  createdAt: { $date: '2026-08-10T08:00:00.000Z' },
  updatedAt: { $date: '2026-08-10T08:00:00.000Z' },
  principalLinks: [],
});
if (reviewerWithOmittedNullableField.rulesAcceptedAt !== null) {
  throw new Error('An omitted nullable Mongo field was not normalized to PostgreSQL NULL.');
}
const reviewerTargetRows = await targetRowsForDataset(
  'reviewer_profiles',
  [reviewerWithOmittedNullableField],
);
const [roundTrippedReviewer] = await canonicalRowsFromTarget('reviewer_profiles', reviewerTargetRows);
if (canonicalJson(roundTrippedReviewer) !== canonicalJson(reviewerWithOmittedNullableField)) {
  throw new Error('A reviewer with an omitted nullable field cannot round-trip through PostgreSQL.');
}

const entrypoint = readFileSync(
  new URL('./crowdsource-backend-recover-archive.mjs', import.meta.url),
  'utf8',
);
for (const required of [
  "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
  "--security-opt=no-new-privileges", "--archive", "--stopOnError",
  "--noIndexRestore", "--numParallelCollections=1", "input: archiveEvidence.archiveBytes",
  "'context', 'show'", "unix:///var/run/docker.sock", "dockerEnvironment()",
  "constants.O_NOFOLLOW", "cleanup.status !== 0",
]) {
  if (!entrypoint.includes(required)) throw new Error(`Archive recovery omitted '${required}'.`);
}
if (!/\^--\(archive\|output\)=/.test(entrypoint)) {
  throw new Error('Archive recovery exposes an option beyond the exact archive/output interface.');
}
if (/--source-(?:database|url)|--mongo-(?:url|image)|--expected-(?:sha|count)/.test(entrypoint)) {
  throw new Error('Archive recovery lets an operator replace a pinned source identity.');
}
if (/env:\s*\{\s*\.\.\.process\.env/.test(entrypoint)) {
  throw new Error('Archive recovery forwards the ambient secret environment to Docker.');
}

const extractor = readFileSync(
  new URL('./crowdsource-backend-recover-archive.mongosh.js', import.meta.url),
  'utf8',
);
for (const required of ['getDBNames()', 'getCollectionInfos', 'countDocuments({})', 'EJSON.stringify']) {
  if (!extractor.includes(required)) throw new Error(`Archive extractor omitted '${required}'.`);
}
if (/mongodb(?:\+srv)?:\/\//i.test(extractor)) {
  throw new Error('Archive extractor embeds a Mongo connection URL.');
}

const dockerfile = readFileSync(new URL('../packages/backend/Dockerfile', import.meta.url), 'utf8');
for (const filename of [
  'crowdsource-backend-recover-archive.mjs',
  'crowdsource-backend-recover-archive.mongosh.js',
]) {
  if (dockerfile.includes(filename)) {
    throw new Error(`Production image copied migration-only '${filename}'.`);
  }
}

process.stdout.write(
  'Archive recovery gate catches checksum, database, collection, count, image, network and runtime-copy mutations.\n',
);
