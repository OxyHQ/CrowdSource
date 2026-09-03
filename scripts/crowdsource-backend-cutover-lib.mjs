import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as createSignature,
  verify as verifySignature,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getTableColumns } from 'drizzle-orm';

export const CUTOVER_FORMAT = 'crowdsource-backend-cutover/v1';
export const CANONICAL_SHAPE = 'crowdsource-backend-domain/v1';
export const FREEZE_FORMAT = 'crowdsource-backend-writer-freeze/v1';
export const RECEIPT_FORMAT = 'crowdsource-backend-import-receipt/v1';
export const ARCHIVE_CENSUS_FORMAT = 'crowdsource-backend-archive-census/v1';
export const ARCHIVE_SOURCE_KIND = 'verified_mongodump_archive';
export const MIGRATION_PHASE = 'all';
export const MIGRATOR_ROLE = 'crowdsource_migrator';
// Generated from independently migrated PostgreSQL 17 Docker and RDS catalogs.
// Changing covered DDL or privileges requires an intentional canonical-catalog
// review; host collation versions are validated before this digest is computed.
export const EXPECTED_POSTGRES_CATALOG_SHA256 =
  'sha256:f585f227d394bdadbd87277ce13855775d7a40c9538b013bfdaf64d7ef1f0fa3';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EMPTY_SHA256 = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Fixed bindings are deliberately explicit. A filename, export order or table
 * order can never redirect a dataset to a different PostgreSQL relation.
 */
export const BACKEND_DATASETS = Object.freeze([
  { name: 'appeals', tableKeys: ['appeals'], targetTables: ['appeals'], identity: ['appealId'] },
  { name: 'app_trust_snapshots', tableKeys: ['appTrustSnapshots'], targetTables: ['app_trust_snapshots'], identity: ['applicationId'] },
  { name: 'application_credentials', tableKeys: ['applicationCredentials'], targetTables: ['application_credentials'], identity: ['credentialId'] },
  { name: 'applications', tableKeys: ['applications'], targetTables: ['applications'], identity: ['applicationId'] },
  { name: 'assignments', tableKeys: ['assignments'], targetTables: ['assignments'], identity: ['assignmentId'] },
  { name: 'audit_events', tableKeys: ['auditEvents'], targetTables: ['audit_events'], identity: ['auditId'] },
  {
    name: 'case_reports',
    tableKeys: ['caseReports'],
    targetTables: ['case_reports'],
    identity: ['applicationId', 'reportId'],
  },
  { name: 'cases', tableKeys: ['cases'], targetTables: ['cases'], identity: ['caseId'] },
  { name: 'decisions', tableKeys: ['decisions'], targetTables: ['decisions'], identity: ['decisionId'] },
  { name: 'organization_members', tableKeys: ['organizationMembers'], targetTables: ['organization_members'], identity: ['membershipId'] },
  { name: 'organizations', tableKeys: ['organizations'], targetTables: ['organizations'], identity: ['organizationId'] },
  { name: 'outbox_events', tableKeys: ['outboxEvents'], targetTables: ['outbox_events'], identity: ['eventId'] },
  {
    name: 'policy_sets',
    tableKeys: ['policySets'],
    targetTables: ['policy_sets'],
    identity: ['applicationId', 'policySetId', 'version'],
  },
  { name: 'reports', tableKeys: ['reports'], targetTables: ['reports'], identity: ['reportId'] },
  { name: 'reviewer_affinities', tableKeys: ['reviewerAffinities'], targetTables: ['reviewer_affinities'], identity: ['pairKey'] },
  {
    name: 'reviewer_profiles',
    tableKeys: ['reviewerProfiles', 'reviewerPrincipalLinks'],
    targetTables: ['reviewer_profiles', 'reviewer_principal_links'],
    identity: ['reviewerId'],
  },
  { name: 'reviewer_relations', tableKeys: ['reviewerRelations'], targetTables: ['reviewer_relations'], identity: ['reviewerRelationId'] },
  { name: 'reviews', tableKeys: ['reviews'], targetTables: ['reviews'], identity: ['reviewId'] },
  { name: 'sortition_draws', tableKeys: ['sortitionDraws'], targetTables: ['sortition_draws'], identity: ['drawId'] },
  { name: 'staff_audit_events', tableKeys: ['staffAuditEvents'], targetTables: ['staff_audit_events'], identity: ['staffAuditId'] },
  { name: 'trust_safety_staff', tableKeys: ['trustSafetyStaff'], targetTables: ['trust_safety_staff'], identity: ['oxyUserId'] },
  {
    name: 'usage_counters',
    tableKeys: ['usageCounters'],
    targetTables: ['usage_counters'],
    identity: ['applicationId', 'day'],
  },
  { name: 'webhook_attempts', tableKeys: ['webhookAttempts'], targetTables: ['webhook_attempts'], identity: ['attemptId'] },
  { name: 'webhook_deliveries', tableKeys: ['webhookDeliveries'], targetTables: ['webhook_deliveries'], identity: ['deliveryId'] },
  { name: 'webhook_endpoints', tableKeys: ['webhookEndpoints'], targetTables: ['webhook_endpoints'], identity: ['webhookEndpointId'] },
  {
    name: 'webhook_secrets',
    tableKeys: ['webhookSecrets'],
    targetTables: ['webhook_secrets'],
    identity: ['applicationId', 'webhookEndpointId', 'version'],
  },
]);

const FINAL_BACKUP_COUNTS = Object.freeze(Object.fromEntries(
  BACKEND_DATASETS.map((dataset) => [dataset.name, dataset.name === 'reviewer_profiles' ? 2 : 0]),
));

/**
 * The sole surviving CrowdSource production source. These are public evidence
 * identifiers, not credentials. Keeping them in code makes a similarly named
 * bucket object, database or mutable image a refusal rather than a fallback.
 */
export const FINAL_BACKUP_RECOVERY_PROFILE = Object.freeze({
  objectUri: 's3://oxy-mongo-backups-usw2-237343248947/final/2026-08-10-pre-drop/crowdsource-production.archive.gz',
  objectVersionId: 'blYwlJUWMzs2QshDbwQ3JJbeMkmFcXBb',
  databaseName: 'crowdsource-production',
  archiveSha256: 'sha256:4417e03de8c98d55637e4d5aac8462414c98f2b7191dd3309ab9af11bf25a994',
  archiveBytes: 3728,
  objectLastModified: '2026-08-10T08:26:45.000Z',
  archiveCreatedByMongoVersion: '8.2.11',
  recoveryImage: 'mongo@sha256:951c2ff9fc6bdb6cb89b1dfea4a0e8ae3ee4fb287c0bf579b2bba54c7803f75d',
  expectedCounts: FINAL_BACKUP_COUNTS,
});

export function assertMongoRecoveryKernelSupported(kernelRelease) {
  if (typeof kernelRelease !== 'string') throw new Error('Recovery kernel release is absent.');
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(kernelRelease);
  if (match === null) throw new Error('Recovery kernel release is not understood.');
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  const affected = (major === 6 && minor >= 19) || (major === 7 && minor === 0 && patch <= 13);
  if (affected) {
    throw new Error(
      `MongoDB 8.2.11 recovery is unsupported on Linux kernel '${kernelRelease}'; ` +
      'use an approved local runner below 6.19 or at least 7.0.14.',
    );
  }
  return { major, minor, patch };
}

const TABLE_IDENTITIES = Object.freeze({
  appeals: ['appealId'],
  appTrustSnapshots: ['applicationId'],
  applicationCredentials: ['credentialId'],
  applications: ['applicationId'],
  assignments: ['assignmentId'],
  auditEvents: ['auditId'],
  caseReports: ['applicationId', 'reportId'],
  cases: ['caseId'],
  decisions: ['decisionId'],
  organizationMembers: ['membershipId'],
  organizations: ['organizationId'],
  outboxEvents: ['eventId'],
  policySets: ['applicationId', 'policySetId', 'version'],
  reports: ['reportId'],
  reviewerAffinities: ['pairKey'],
  reviewerProfiles: ['reviewerId'],
  reviewerPrincipalLinks: ['reviewerId', 'applicationId', 'externalPrincipalId'],
  reviewerRelations: ['reviewerRelationId'],
  reviews: ['reviewId'],
  sortitionDraws: ['drawId'],
  staffAuditEvents: ['staffAuditId'],
  trustSafetyStaff: ['oxyUserId'],
  usageCounters: ['applicationId', 'day'],
  webhookAttempts: ['attemptId'],
  webhookDeliveries: ['deliveryId'],
  webhookEndpoints: ['webhookEndpointId'],
  webhookSecrets: ['applicationId', 'webhookEndpointId', 'version'],
});

const DECISION_JURY_FIELDS = Object.freeze({
  size: 'jurySize',
  decisiveVotes: 'juryDecisiveVotes',
  winningVotes: 'juryWinningVotes',
  agreement: 'juryAgreement',
  specialistPresent: 'jurySpecialistPresent',
});
const DECISION_POLICY_FIELDS = Object.freeze({
  taxonomy: 'policyVersionTaxonomy',
  application: 'policyVersionApplication',
  oxyConduct: 'policyVersionOxyConduct',
});

let schemaPromise;

async function loadSchema() {
  if (schemaPromise === undefined) {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const source = join(repositoryRoot, 'packages/backend/src/db/postgres/schema/index.ts');
    const compiled = join(repositoryRoot, 'packages/backend/dist/src/db/postgres/schema/index.js');
    const selected = existsSync(source) ? source : compiled;
    if (!existsSync(selected)) {
      throw new Error('The CrowdSource PostgreSQL schema is absent; refusing an untyped import.');
    }
    schemaPromise = import(pathToFileURL(selected).href);
  }
  return schemaPromise;
}

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function canonicalValue(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('An invalid date cannot be canonicalized.');
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('A non-finite number cannot be canonicalized.');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  throw new Error(`Unsupported canonical value type '${typeof value}'.`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertSha256(value, label, { allowEmpty = false } = {}) {
  if (!SHA256_PATTERN.test(value ?? '')) throw new Error(`${label} is not a SHA-256 digest.`);
  const hex = value.slice('sha256:'.length);
  if (/^([0-9a-f])\1{63}$/.test(hex)) throw new Error(`${label} is a placeholder digest.`);
  if (!allowEmpty && value === EMPTY_SHA256) throw new Error(`${label} is vacuous.`);
}

function assertUtcTimestamp(value, label) {
  if (!UTC_TIMESTAMP_PATTERN.test(value ?? '') || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is not a canonical UTC timestamp.`);
  }
}

function normalizeExtendedJson(value, path = '$') {
  if (Array.isArray(value)) return value.map((entry, index) => normalizeExtendedJson(entry, `${path}[${index}]`));
  if (!plainObject(value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number.`);
    }
    return value;
  }

  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$oid') {
    if (typeof value.$oid !== 'string' || !OBJECT_ID_PATTERN.test(value.$oid)) {
      throw new Error(`${path} contains an invalid BSON ObjectId.`);
    }
    return value.$oid;
  }
  if (keys.length === 1 && keys[0] === '$date') {
    let dateValue = value.$date;
    if (plainObject(dateValue) && Object.keys(dateValue).length === 1 && '$numberLong' in dateValue) {
      dateValue = dateValue.$numberLong;
    }
    const date = typeof dateValue === 'string' && /^-?\d+$/.test(dateValue)
      ? new Date(Number(dateValue))
      : new Date(dateValue);
    if (Number.isNaN(date.getTime())) throw new Error(`${path} contains an invalid BSON date.`);
    return date.toISOString();
  }
  for (const tag of ['$numberInt', '$numberLong']) {
    if (keys.length === 1 && keys[0] === tag) {
      const encoded = value[tag];
      if (typeof encoded !== 'string' || !/^-?\d+$/.test(encoded)) {
        throw new Error(`${path} contains an invalid ${tag}.`);
      }
      const parsed = Number(encoded);
      if (!Number.isSafeInteger(parsed) || String(parsed) !== encoded) {
        throw new Error(`${path} contains a ${tag} that cannot be represented exactly.`);
      }
      return parsed;
    }
  }
  if (keys.length === 1 && keys[0] === '$numberDouble') {
    const encoded = value.$numberDouble;
    const parsed = typeof encoded === 'string' ? Number(encoded) : Number.NaN;
    if (!Number.isFinite(parsed)) throw new Error(`${path} contains an unsupported BSON double.`);
    return parsed;
  }
  if (keys.length === 1 && keys[0] === '$numberDecimal') {
    throw new Error(`${path} contains BSON Decimal128, which has no reviewed lossless mapping.`);
  }
  if (keys.length === 1 && keys[0] === '$binary') {
    const binary = value.$binary;
    if (
      !plainObject(binary) ||
      typeof binary.base64 !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(binary.base64) ||
      typeof binary.subType !== 'string' ||
      !/^[0-9a-f]{2}$/.test(binary.subType)
    ) {
      throw new Error(`${path} contains invalid BSON binary data.`);
    }
    return { $binary: { base64: binary.base64, subType: binary.subType } };
  }
  const unsupported = keys.find((key) => key.startsWith('$'));
  if (unsupported !== undefined) {
    throw new Error(`${path} contains unhandled BSON tag '${unsupported}'.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeExtendedJson(entry, `${path}.${key}`)]),
  );
}

function fixedDataset(name) {
  const dataset = BACKEND_DATASETS.find((candidate) => candidate.name === name);
  if (dataset === undefined) throw new Error(`Dataset '${name}' is not in the fixed mapping.`);
  return dataset;
}

async function tableMetadata(tableKey) {
  const schema = await loadSchema();
  const table = schema[tableKey];
  if (table === undefined) throw new Error(`Schema export '${tableKey}' is absent.`);
  const columns = getTableColumns(table);
  const tableName = String(Reflect.get(table, Symbol.for('drizzle:Name')) ?? '');
  if (!/^[a-z][a-z0-9_]*$/.test(tableName)) throw new Error(`Unsafe table name '${tableName}'.`);
  return { table, tableName, columns };
}

async function canonicalFields(dataset) {
  const { columns } = await tableMetadata(dataset.tableKeys[0]);
  const fields = new Set(Object.keys(columns));
  if (dataset.name === 'organization_members') {
    fields.delete('roles');
    fields.add('role');
  }
  if (dataset.name === 'decisions') {
    for (const field of [...Object.values(DECISION_JURY_FIELDS), ...Object.values(DECISION_POLICY_FIELDS)]) {
      fields.delete(field);
    }
    fields.add('jury');
    fields.add('policyVersions');
  }
  if (dataset.name === 'reviewer_profiles') fields.add('principalLinks');
  return fields;
}

function assertExactObjectFields(object, allowed, label) {
  if (!plainObject(object)) throw new Error(`${label} must be an object.`);
  for (const field of Object.keys(object)) {
    if (!allowed.has(field)) throw new Error(`${label} contains unknown field '${field}'.`);
  }
}

export function archiveSourceFingerprint(profile) {
  return sha256({
    kind: ARCHIVE_SOURCE_KIND,
    objectUri: profile.objectUri,
    objectVersionId: profile.objectVersionId,
    databaseName: profile.databaseName,
    archiveSha256: profile.archiveSha256,
    archiveBytes: profile.archiveBytes,
    archiveCreatedByMongoVersion: profile.archiveCreatedByMongoVersion,
  });
}

/**
 * Validate the immutable archive and the census produced only after an
 * isolated restore. `profile` is injectable for mutation tests; the production
 * entrypoint always passes FINAL_BACKUP_RECOVERY_PROFILE and exposes no option
 * that can replace it.
 */
export function validateArchiveRecoveryEvidence({ archivePath, archiveBytes: providedArchiveBytes, census, profile }) {
  assertExactObjectFields(
    profile,
    new Set([
      'objectUri', 'objectVersionId', 'databaseName', 'archiveSha256',
      'archiveBytes', 'objectLastModified', 'archiveCreatedByMongoVersion',
      'recoveryImage', 'expectedCounts',
    ]),
    'Archive recovery profile',
  );
  if (typeof profile.objectUri !== 'string' || !profile.objectUri.startsWith('s3://')) {
    throw new Error('Archive recovery object URI is invalid.');
  }
  if (typeof profile.objectVersionId !== 'string' || !/^[A-Za-z0-9._-]{16,128}$/.test(profile.objectVersionId)) {
    throw new Error('Archive recovery object version is invalid.');
  }
  if (typeof profile.databaseName !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(profile.databaseName)) {
    throw new Error('Archive recovery database name is invalid.');
  }
  assertSha256(profile.archiveSha256, 'Archive recovery SHA-256');
  if (!Number.isSafeInteger(profile.archiveBytes) || profile.archiveBytes < 1) {
    throw new Error('Archive recovery byte length is invalid.');
  }
  assertUtcTimestamp(profile.objectLastModified, 'Archive object last-modified timestamp');
  if (!/^\d+\.\d+\.\d+$/.test(profile.archiveCreatedByMongoVersion)) {
    throw new Error('Archive MongoDB producer version is invalid.');
  }
  if (
    typeof profile.recoveryImage !== 'string' ||
    !/^mongo@sha256:[0-9a-f]{64}$/.test(profile.recoveryImage)
  ) {
    throw new Error('Archive recovery image is not pinned by digest.');
  }
  assertExactObjectFields(
    profile.expectedCounts,
    new Set(BACKEND_DATASETS.map((dataset) => dataset.name)),
    'Archive expected counts',
  );

  if ((archivePath === undefined) === (providedArchiveBytes === undefined)) {
    throw new Error('Archive recovery requires exactly one path or in-memory byte source.');
  }
  let archiveBytes;
  if (providedArchiveBytes !== undefined) {
    if (!Buffer.isBuffer(providedArchiveBytes)) throw new Error('Archive recovery bytes are invalid.');
    archiveBytes = providedArchiveBytes;
  } else {
    const archive = resolve(archivePath);
    const archiveStat = statSync(archive);
    if (!archiveStat.isFile()) throw new Error('Archive recovery input is not a regular file.');
    archiveBytes = readFileSync(archive);
  }
  if (archiveBytes.byteLength !== profile.archiveBytes) {
    throw new Error('Archive byte length differs from the pinned backup.');
  }
  if (sha256(archiveBytes) !== profile.archiveSha256) {
    throw new Error('Archive SHA-256 differs from the pinned backup.');
  }

  assertExactObjectFields(
    census,
    new Set(['format', 'databaseName', 'collections']),
    'Archive recovery census',
  );
  if (census.format !== ARCHIVE_CENSUS_FORMAT || census.databaseName !== profile.databaseName) {
    throw new Error('Archive recovery census names a different source.');
  }
  if (!Array.isArray(census.collections) || census.collections.length !== BACKEND_DATASETS.length) {
    throw new Error('Archive recovery census does not contain exactly 26 collections.');
  }
  let totalCount = 0;
  for (let index = 0; index < BACKEND_DATASETS.length; index += 1) {
    const fixed = BACKEND_DATASETS[index];
    const collection = census.collections[index];
    assertExactObjectFields(collection, new Set(['name', 'count']), `Archive collection ${index}`);
    if (collection.name !== fixed.name) {
      throw new Error(`Archive collection position ${index} is not fixed '${fixed.name}'.`);
    }
    if (!Number.isSafeInteger(collection.count) || collection.count < 0) {
      throw new Error(`Archive collection '${fixed.name}' count is invalid.`);
    }
    if (collection.count !== profile.expectedCounts[fixed.name]) {
      throw new Error(`Archive collection '${fixed.name}' count differs from the final backup census.`);
    }
    totalCount += collection.count;
  }
  if (totalCount < 1) throw new Error('Archive recovery census is vacuously empty.');
  return {
    archiveBytes,
    archiveSha256: profile.archiveSha256,
    archiveBytesCount: profile.archiveBytes,
    databaseFingerprint: archiveSourceFingerprint(profile),
    censusSha256: sha256(`${canonicalJson(census)}\n`),
    totalCount,
  };
}

function identityProjection(row, identity, label) {
  const projected = {};
  for (const field of identity) {
    const value = row[field];
    if (value === undefined || value === null || value === '') {
      throw new Error(`${label} has no exact identity field '${field}'.`);
    }
    if (!['string', 'number'].includes(typeof value)) {
      throw new Error(`${label} identity field '${field}' has an unsupported type.`);
    }
    projected[field] = value;
  }
  return projected;
}

function sortCanonicalRows(rows, identity, label) {
  const keyed = rows.map((row, index) => {
    const canonical = canonicalValue(row);
    return {
      row: canonical,
      identityBytes: canonicalJson(identityProjection(canonical, identity, `${label}[${index}]`)),
    };
  });
  keyed.sort((left, right) => left.identityBytes.localeCompare(right.identityBytes));
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index - 1].identityBytes === keyed[index].identityBytes) {
      throw new Error(`${label} contains a duplicate identity.`);
    }
  }
  return keyed;
}

export function evidenceForRows(rows, identity, label) {
  const sorted = sortCanonicalRows(rows, identity, label);
  const bytes = sorted.map(({ row }) => `${canonicalJson(row)}\n`).join('');
  const identityBytes = sorted.map(({ identityBytes }) => `${identityBytes}\n`).join('');
  return {
    rows: sorted.map(({ row }) => row),
    bytes,
    count: sorted.length,
    sha256: sha256(bytes),
    identitySha256: sha256(identityBytes),
  };
}

function normalizePrincipalLinks(links) {
  if (!Array.isArray(links)) throw new Error('Reviewer profile principalLinks must be an array.');
  const normalized = links.map((link, index) => {
    const value = normalizeExtendedJson(link, `reviewer profile principalLinks[${index}]`);
    assertExactObjectFields(
      value,
      new Set(['applicationId', 'externalPrincipalId']),
      `Reviewer profile principalLinks[${index}]`,
    );
    identityProjection(
      value,
      ['applicationId', 'externalPrincipalId'],
      `Reviewer profile principalLinks[${index}]`,
    );
    return value;
  });
  return evidenceForRows(
    normalized,
    ['applicationId', 'externalPrincipalId'],
    'Reviewer profile principalLinks',
  ).rows;
}

export async function canonicalizeSourceDocument(datasetName, rawDocument) {
  const dataset = fixedDataset(datasetName);
  const normalized = normalizeExtendedJson(rawDocument, `${datasetName} document`);
  if (!plainObject(normalized)) throw new Error(`${datasetName} document must be an object.`);
  const document = { ...normalized };
  const storageId = document._id;
  delete document._id;
  delete document.__v;

  if (datasetName === 'organization_members') {
    if (typeof storageId !== 'string' || !OBJECT_ID_PATTERN.test(storageId)) {
      throw new Error('organization_members._id must be an exact BSON ObjectId.');
    }
    if (document.membershipId !== undefined) {
      throw new Error('organization_members must not already contain membershipId.');
    }
    document.membershipId = storageId;
  } else if (datasetName === 'reviewer_relations') {
    if (typeof storageId !== 'string' || !OBJECT_ID_PATTERN.test(storageId)) {
      throw new Error('reviewer_relations._id must be an exact BSON ObjectId.');
    }
    if (document.reviewerRelationId !== undefined) {
      throw new Error('reviewer_relations must not already contain reviewerRelationId.');
    }
    document.reviewerRelationId = storageId;
  }

  const allowed = await canonicalFields(dataset);
  assertExactObjectFields(document, allowed, `${datasetName} document`);
  identityProjection(document, dataset.identity, `${datasetName} document`);
  if (datasetName === 'reviewer_profiles') {
    document.principalLinks = normalizePrincipalLinks(document.principalLinks);
  }

  // PostgreSQL has one representation for a nullable column: SQL NULL. Mongo
  // distinguishes an absent property from an explicit null, so normalize only
  // nullable primary-table fields into the target's canonical representation
  // before hashing. Without this, a valid source document with an omitted
  // nullable field can be imported losslessly at the domain level but can never
  // reproduce byte-identical evidence after PostgreSQL re-export.
  const { columns } = await tableMetadata(dataset.tableKeys[0]);
  for (const [field, column] of Object.entries(columns)) {
    if (allowed.has(field) && column.notNull !== true && !Object.hasOwn(document, field)) {
      document[field] = null;
    }
  }
  return canonicalValue(document);
}

function encodeDecision(row) {
  const encoded = { ...row };
  const jury = encoded.jury;
  const policyVersions = encoded.policyVersions;
  delete encoded.jury;
  delete encoded.policyVersions;
  assertExactObjectFields(jury, new Set(Object.keys(DECISION_JURY_FIELDS)), 'decision.jury');
  assertExactObjectFields(
    policyVersions,
    new Set(Object.keys(DECISION_POLICY_FIELDS)),
    'decision.policyVersions',
  );
  for (const [source, target] of Object.entries(DECISION_JURY_FIELDS)) encoded[target] = jury[source];
  for (const [source, target] of Object.entries(DECISION_POLICY_FIELDS)) {
    encoded[target] = policyVersions[source];
  }
  return encoded;
}

function decodeDecision(row) {
  const decoded = { ...row, jury: {}, policyVersions: {} };
  for (const [source, target] of Object.entries(DECISION_JURY_FIELDS)) {
    decoded.jury[source] = decoded[target];
    delete decoded[target];
  }
  for (const [source, target] of Object.entries(DECISION_POLICY_FIELDS)) {
    decoded.policyVersions[source] = decoded[target];
    delete decoded[target];
  }
  return decoded;
}

async function materializeTableRow(tableKey, row, label) {
  const { columns } = await tableMetadata(tableKey);
  assertExactObjectFields(row, new Set(Object.keys(columns)), label);
  const materialized = {};
  for (const [field, column] of Object.entries(columns)) {
    let value = row[field];
    if (value === undefined) {
      if (column.notNull) {
        throw new Error(`${label} is missing non-null PostgreSQL field '${field}'.`);
      }
      value = null;
    }
    if (value !== null && column.dataType === 'date') {
      if (typeof value !== 'string') throw new Error(`${label}.${field} is not a canonical timestamp.`);
      assertUtcTimestamp(value, `${label}.${field}`);
    }
    materialized[field] = value;
  }
  return materialized;
}

export async function targetRowsForDataset(datasetName, canonicalRows) {
  const dataset = fixedDataset(datasetName);
  const rowsByTableKey = Object.fromEntries(dataset.tableKeys.map((tableKey) => [tableKey, []]));
  for (const [index, sourceRow] of canonicalRows.entries()) {
    const label = `${datasetName}[${index}]`;
    let primary = { ...sourceRow };
    if (datasetName === 'organization_members') {
      const role = primary.role;
      delete primary.role;
      if (typeof role !== 'string' || role.length === 0) throw new Error(`${label}.role is invalid.`);
      primary.roles = [role];
    } else if (datasetName === 'decisions') {
      primary = encodeDecision(primary);
    } else if (datasetName === 'reviewer_profiles') {
      const links = primary.principalLinks;
      delete primary.principalLinks;
      for (const link of normalizePrincipalLinks(links)) {
        rowsByTableKey.reviewerPrincipalLinks.push(await materializeTableRow(
          'reviewerPrincipalLinks',
          {
            reviewerId: primary.reviewerId,
            ...link,
            createdAt: primary.createdAt,
            updatedAt: primary.updatedAt,
          },
          `${label}.principalLinks`,
        ));
      }
    }
    rowsByTableKey[dataset.tableKeys[0]].push(
      await materializeTableRow(dataset.tableKeys[0], primary, label),
    );
  }
  return rowsByTableKey;
}

export async function canonicalRowsFromTarget(datasetName, rowsByTableKey) {
  const dataset = fixedDataset(datasetName);
  const primaryRows = rowsByTableKey[dataset.tableKeys[0]] ?? [];
  if (datasetName === 'organization_members') {
    return primaryRows.map((row, index) => {
      const roles = row.roles;
      if (!Array.isArray(roles) || roles.length !== 1 || typeof roles[0] !== 'string') {
        throw new Error(`organization_members target row ${index} cannot reconstruct one legacy role.`);
      }
      const decoded = { ...row, role: roles[0] };
      delete decoded.roles;
      return decoded;
    });
  }
  if (datasetName === 'decisions') return primaryRows.map(decodeDecision);
  if (datasetName === 'reviewer_profiles') {
    const links = rowsByTableKey.reviewerPrincipalLinks ?? [];
    const linksByReviewer = new Map();
    for (const link of links) {
      const reviewerId = link.reviewerId;
      if (typeof reviewerId !== 'string') throw new Error('A reviewer principal link has no reviewerId.');
      const group = linksByReviewer.get(reviewerId) ?? [];
      group.push({
        applicationId: link.applicationId,
        externalPrincipalId: link.externalPrincipalId,
      });
      linksByReviewer.set(reviewerId, group);
    }
    const reviewerIds = new Set(primaryRows.map((row) => row.reviewerId));
    for (const reviewerId of linksByReviewer.keys()) {
      if (!reviewerIds.has(reviewerId)) {
        throw new Error('Principal links exist for an absent reviewer.');
      }
    }
    return primaryRows.map((row) => ({
      ...row,
      principalLinks: normalizePrincipalLinks(linksByReviewer.get(row.reviewerId) ?? []),
    }));
  }
  return primaryRows;
}

export async function tableEvidenceForDataset(datasetName, rowsByTableKey, side) {
  const dataset = fixedDataset(datasetName);
  const tables = [];
  for (const tableKey of dataset.tableKeys) {
    const { tableName } = await tableMetadata(tableKey);
    const evidence = evidenceForRows(
      rowsByTableKey[tableKey] ?? [],
      TABLE_IDENTITIES[tableKey],
      `${datasetName}.${tableName}`,
    );
    tables.push({
      name: tableName,
      [`${side}Count`]: evidence.count,
      [`${side}Sha256`]: evidence.sha256,
      [`${side}IdentitySha256`]: evidence.identitySha256,
    });
  }
  return tables;
}

export function databaseFingerprint(connectionUrl, databaseName, kind) {
  let parsed;
  try {
    const normalized = connectionUrl.replace(/^mongodb(?:\+srv)?:\/\//, 'https://');
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${kind} connection URL cannot be parsed.`);
  }
  const pathDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (pathDatabase !== databaseName) {
    throw new Error(`${kind} URL names database '${pathDatabase}', not '${databaseName}'.`);
  }
  const originalScheme = connectionUrl.startsWith('mongodb+srv://')
    ? 'mongodb+srv'
    : connectionUrl.startsWith('mongodb://')
      ? 'mongodb'
      : parsed.protocol.replace(/:$/, '');
  const hosts = parsed.host.toLowerCase();
  if (hosts.length === 0) throw new Error(`${kind} URL has no endpoint.`);
  const replicaSet = parsed.searchParams.get('replicaSet') ?? '';
  return sha256({ kind, scheme: originalScheme, hosts, databaseName, replicaSet });
}

function freezeSigningBytes(attestation) {
  const unsigned = { ...attestation };
  delete unsigned.signature;
  return Buffer.from(canonicalJson(unsigned));
}

export function signFreezeAttestation(unsignedAttestation, privateKeyPem) {
  if (unsignedAttestation?.signature !== undefined) {
    throw new Error('Unsigned freeze input already contains a signature.');
  }
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Freeze signing key must be Ed25519.');
  return {
    ...unsignedAttestation,
    signature: createSignature(null, freezeSigningBytes(unsignedAttestation), privateKey).toString('base64'),
  };
}

export function freezePublicKeyFingerprint(publicKeyPem) {
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Freeze key must be Ed25519.');
  return sha256(publicKey.export({ type: 'spki', format: 'der' }));
}

function nonPlaceholder(value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    /(?:placeholder|example|sample|dummy|todo|changeme)/i.test(value)
  ) {
    throw new Error(`${label} is absent or looks like a placeholder.`);
  }
}

export function verifyFreezeAttestation(attestation, publicKeyPem, expected) {
  if (attestation?.format !== FREEZE_FORMAT) throw new Error('Freeze attestation format is invalid.');
  if (attestation?.writesFrozen !== true) throw new Error('Freeze attestation does not freeze writes.');
  if (attestation?.sourceDatabase !== expected.databaseName) {
    throw new Error('Freeze attestation names a different source database.');
  }
  if (attestation?.sourceDatabaseFingerprint !== expected.databaseFingerprint) {
    throw new Error('Freeze attestation names a different source endpoint.');
  }
  assertSha256(attestation.sourceDatabaseFingerprint, 'Freeze source fingerprint');
  nonPlaceholder(attestation.changeId, 'Freeze changeId');
  assertUtcTimestamp(attestation.observedFrom, 'Freeze observation start');
  assertUtcTimestamp(attestation.observedUntil, 'Freeze observation end');
  const observedFrom = Date.parse(attestation.observedFrom);
  const observedUntil = Date.parse(attestation.observedUntil);
  if (observedUntil - observedFrom < 60_000) {
    throw new Error('Freeze observation interval is shorter than 60 seconds.');
  }
  if (!Array.isArray(attestation.writers) || attestation.writers.length === 0) {
    throw new Error('Freeze attestation has no enumerated writers.');
  }
  const writerIds = new Set();
  for (const [index, writer] of attestation.writers.entries()) {
    nonPlaceholder(writer?.id, `Freeze writer ${index} id`);
    assertUtcTimestamp(writer?.stoppedAt, `Freeze writer ${writer?.id} stoppedAt`);
    assertUtcTimestamp(writer?.verifiedAt, `Freeze writer ${writer?.id} verifiedAt`);
    if (writerIds.has(writer.id)) throw new Error(`Freeze writer '${writer.id}' is duplicated.`);
    writerIds.add(writer.id);
    const stoppedAt = Date.parse(writer.stoppedAt);
    const verifiedAt = Date.parse(writer.verifiedAt);
    if (
      stoppedAt > observedFrom ||
      verifiedAt < observedFrom ||
      verifiedAt > observedUntil ||
      stoppedAt > verifiedAt
    ) {
      throw new Error(`Freeze writer '${writer.id}' was not stopped before and verified during the evidence window.`);
    }
  }
  const nonce = typeof attestation.nonce === 'string'
    ? Buffer.from(attestation.nonce, 'base64')
    : Buffer.alloc(0);
  if (nonce.length < 32 || nonce.toString('base64') !== attestation.nonce) {
    throw new Error('Freeze attestation nonce is not canonical random evidence.');
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Freeze key must be Ed25519.');
  const signature = typeof attestation.signature === 'string'
    ? Buffer.from(attestation.signature, 'base64')
    : Buffer.alloc(0);
  if (
    signature.length !== 64 ||
    signature.toString('base64') !== attestation.signature ||
    !verifySignature(null, freezeSigningBytes(attestation), publicKey, signature)
  ) {
    throw new Error('Freeze attestation signature is invalid.');
  }
  const publicKeySha256 = freezePublicKeyFingerprint(publicKeyPem);
  return {
    attestationSha256: sha256(canonicalJson(attestation)),
    publicKeySha256,
    observedUntil: attestation.observedUntil,
  };
}

function secureNewDirectory(path) {
  const parent = dirname(path);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error(`Parent directory '${parent}' does not exist.`);
  }
  if (existsSync(path)) throw new Error(`Output '${path}' already exists.`);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function secureWrite(path, content, mode = 0o600) {
  if (existsSync(path)) throw new Error(`Refusing to overwrite '${path}'.`);
  writeFileSync(path, content, { encoding: 'utf8', mode, flag: 'wx' });
  chmodSync(path, mode);
}

function secureWriteBytes(path, content, mode = 0o600) {
  if (existsSync(path)) throw new Error(`Refusing to overwrite '${path}'.`);
  writeFileSync(path, content, { mode, flag: 'wx' });
  chmodSync(path, mode);
}

export function atomicEvidenceWrite(path, value) {
  const target = resolve(path);
  const parent = dirname(target);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error(`Evidence directory '${parent}' does not exist.`);
  }
  const temporary = join(parent, `.${randomBytes(12).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${canonicalJson(value)}\n`, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    chmodSync(target, 0o600);

    // `rename` is atomic but not durable on its own. Syncing the file before
    // rename and its parent directory afterwards prevents a machine restart
    // from committing PostgreSQL while forgetting the prepared receipt that is
    // required to reconcile that non-empty target safely.
    const parentDescriptor = openSync(parent, 'r');
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the write failure */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* preserve the write failure */ }
    }
    throw error;
  }
}

export function readJsonFile(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

async function writeCanonicalSourceBundle({
  outputDirectory,
  rawDocumentsByDataset,
  schemaVersion,
  source,
  evidenceFiles,
  rawDirectory,
}) {
  const journal = migrationJournalEvidence();
  const output = resolve(outputDirectory);
  secureNewDirectory(output);
  const sourceDirectory = join(output, 'source');
  mkdirSync(sourceDirectory, { mode: 0o700 });
  chmodSync(sourceDirectory, 0o700);
  for (const evidence of evidenceFiles) {
    if (!/^[a-z0-9][a-z0-9.-]+$/.test(evidence.filename)) {
      throw new Error(`Unsafe source evidence filename '${evidence.filename}'.`);
    }
    if (Buffer.isBuffer(evidence.content)) {
      secureWriteBytes(join(output, evidence.filename), evidence.content, 0o400);
    } else {
      secureWrite(join(output, evidence.filename), evidence.content, 0o400);
    }
  }

  const datasets = [];
  for (const dataset of BACKEND_DATASETS) {
    const rawDocuments = rawDocumentsByDataset[dataset.name];
    if (!Array.isArray(rawDocuments)) throw new Error(`Raw dataset '${dataset.name}' is absent.`);
    const canonicalRows = [];
    for (const document of rawDocuments) {
      canonicalRows.push(await canonicalizeSourceDocument(dataset.name, document));
    }
    const sourceEvidence = evidenceForRows(canonicalRows, dataset.identity, dataset.name);
    const sourceFile = `source/${dataset.name}.ndjson`;
    secureWrite(join(output, sourceFile), sourceEvidence.bytes, 0o400);
    const targetRows = await targetRowsForDataset(dataset.name, sourceEvidence.rows);
    const reconstructedRows = await canonicalRowsFromTarget(dataset.name, targetRows);
    const reconstructedEvidence = evidenceForRows(
      reconstructedRows,
      dataset.identity,
      `${dataset.name} reconstructed export`,
    );
    if (
      sourceEvidence.count !== reconstructedEvidence.count ||
      sourceEvidence.sha256 !== reconstructedEvidence.sha256 ||
      sourceEvidence.identitySha256 !== reconstructedEvidence.identitySha256
    ) {
      throw new Error(`Dataset '${dataset.name}' cannot round-trip through the pinned PostgreSQL shape.`);
    }
    const tableEvidence = await tableEvidenceForDataset(dataset.name, targetRows, 'source');
    datasets.push({
      name: dataset.name,
      sourceCollection: dataset.name,
      sourceFile,
      targetTables: tableEvidence.map((table) => table.name),
      sourceCount: sourceEvidence.count,
      sourceSha256: sourceEvidence.sha256,
      sourceIdentitySha256: sourceEvidence.identitySha256,
      tables: tableEvidence,
    });
  }
  const sourceTotalCount = datasets.reduce((total, dataset) => total + dataset.sourceCount, 0);
  if (sourceTotalCount < 1) throw new Error('Source export is empty across every dataset.');

  const manifest = {
    format: CUTOVER_FORMAT,
    schemaVersion,
    canonicalShape: CANONICAL_SHAPE,
    migrationPhase: MIGRATION_PHASE,
    migrationJournalSha256: journal.sha256,
    source: { ...source, totalCount: sourceTotalCount },
    datasets,
  };
  secureWrite(join(output, 'source-manifest.json'), `${canonicalJson(manifest)}\n`, 0o400);
  if (rawDirectory !== undefined) {
    const rawPath = resolve(rawDirectory);
    const destination = join(output, 'raw');
    if (!statSync(rawPath).isDirectory()) throw new Error('Raw archive path is not a directory.');
    if (existsSync(destination)) throw new Error(`Raw archive destination '${destination}' exists.`);
    const relativePath = relative(output, rawPath);
    if (!(relativePath.startsWith(`..${sep}`) || relativePath === '..')) {
      throw new Error('Raw staging directory must be outside the evidence bundle.');
    }
    renameSync(rawPath, destination);
    for (const filename of readdirSync(destination)) chmodSync(join(destination, filename), 0o400);
    chmodSync(destination, 0o500);
  }
  return manifest;
}

export async function createSourceBundle({
  outputDirectory,
  rawDocumentsByDataset,
  sourceDatabase,
  sourceDatabaseFingerprint,
  capturedAt,
  freezeAttestation,
  freezePublicKeyPem,
  rawDirectory,
}) {
  assertUtcTimestamp(capturedAt, 'Source capture timestamp');
  assertSha256(sourceDatabaseFingerprint, 'Source database fingerprint');
  const freeze = verifyFreezeAttestation(freezeAttestation, freezePublicKeyPem, {
    databaseName: sourceDatabase,
    databaseFingerprint: sourceDatabaseFingerprint,
  });
  if (Date.parse(capturedAt) < Date.parse(freeze.observedUntil)) {
    throw new Error('Source capture precedes the completed freeze observation.');
  }
  return writeCanonicalSourceBundle({
    outputDirectory,
    rawDocumentsByDataset,
    schemaVersion: 1,
    source: {
      databaseName: sourceDatabase,
      databaseFingerprint: sourceDatabaseFingerprint,
      capturedAt,
      writesFrozen: true,
      freezeAttestationFile: 'freeze-attestation.json',
      freezeAttestationSha256: freeze.attestationSha256,
      freezePublicKeyFile: 'freeze-public-key.pem',
      freezePublicKeySha256: freeze.publicKeySha256,
      readConcern: 'snapshot',
      readPreference: 'primary',
      transactionallyConsistent: true,
    },
    evidenceFiles: [
      { filename: 'freeze-attestation.json', content: `${canonicalJson(freezeAttestation)}\n` },
      { filename: 'freeze-public-key.pem', content: freezePublicKeyPem },
    ],
    rawDirectory,
  });
}

export async function createArchivedSourceBundle({
  outputDirectory,
  rawDocumentsByDataset,
  archiveBytes,
  census,
  rawDirectory,
  profile = FINAL_BACKUP_RECOVERY_PROFILE,
}) {
  const evidence = validateArchiveRecoveryEvidence({ archiveBytes, census, profile });
  for (const dataset of BACKEND_DATASETS) {
    const documents = rawDocumentsByDataset[dataset.name];
    if (!Array.isArray(documents) || documents.length !== profile.expectedCounts[dataset.name]) {
      throw new Error(`Recovered dataset '${dataset.name}' differs from the verified archive census.`);
    }
  }
  const censusBytes = `${canonicalJson(census)}\n`;
  return writeCanonicalSourceBundle({
    outputDirectory,
    rawDocumentsByDataset,
    schemaVersion: 2,
    source: {
      evidenceKind: ARCHIVE_SOURCE_KIND,
      databaseName: profile.databaseName,
      databaseFingerprint: evidence.databaseFingerprint,
      capturedAt: profile.objectLastModified,
      sourceRetired: true,
      archiveFile: 'source.archive.gz',
      archiveObjectUri: profile.objectUri,
      archiveObjectVersionId: profile.objectVersionId,
      archiveSha256: evidence.archiveSha256,
      archiveBytes: evidence.archiveBytesCount,
      archiveCreatedByMongoVersion: profile.archiveCreatedByMongoVersion,
      archiveCensusFile: 'archive-census.json',
      archiveCensusSha256: evidence.censusSha256,
      recoveryImage: profile.recoveryImage,
      networkIsolatedRestore: true,
      exactNamespaceCensus: true,
    },
    evidenceFiles: [
      { filename: 'source.archive.gz', content: evidence.archiveBytes },
      { filename: 'archive-census.json', content: censusBytes },
    ],
    rawDirectory,
  });
}

function readCanonicalNdjson(path, expectedName) {
  const bytes = readFileSync(path, 'utf8');
  if (bytes.length > 0 && !bytes.endsWith('\n')) throw new Error(`${expectedName} has no final newline.`);
  const rows = bytes.length === 0
    ? []
    : bytes.slice(0, -1).split('\n').map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${expectedName} line ${index + 1} is not JSON.`);
      }
    });
  return { bytes, rows };
}

function exactStrings(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function assertEvidenceFields(holder, prefix, expected, label) {
  const count = holder[`${prefix}Count`];
  const digest = holder[`${prefix}Sha256`];
  const identityDigest = holder[`${prefix}IdentitySha256`];
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label} count is invalid.`);
  assertSha256(digest, `${label} digest`, { allowEmpty: count === 0 });
  assertSha256(identityDigest, `${label} identity digest`, { allowEmpty: count === 0 });
  if (count === 0 && (digest !== EMPTY_SHA256 || identityDigest !== EMPTY_SHA256)) {
    throw new Error(`${label} empty evidence has a non-empty digest.`);
  }
  if (count > 0 && (digest === EMPTY_SHA256 || identityDigest === EMPTY_SHA256)) {
    throw new Error(`${label} non-empty evidence has an empty digest.`);
  }
  if (expected !== undefined) {
    if (count !== expected.count || digest !== expected.sha256 || identityDigest !== expected.identitySha256) {
      throw new Error(`${label} evidence does not match its canonical bytes.`);
    }
  }
}

export async function loadAndVerifySourceBundle(bundleDirectory) {
  const bundle = resolve(bundleDirectory);
  const manifestPath = join(bundle, 'source-manifest.json');
  const manifestBytes = readFileSync(manifestPath, 'utf8');
  const manifest = readJsonFile(manifestPath, 'Source manifest');
  if (`${canonicalJson(manifest)}\n` !== manifestBytes) {
    throw new Error('Source manifest is not canonical JSON.');
  }
  if (manifest.format !== CUTOVER_FORMAT || ![1, 2].includes(manifest.schemaVersion)) {
    throw new Error('Source manifest schema/version is invalid.');
  }
  assertExactObjectFields(
    manifest,
    new Set([
      'format', 'schemaVersion', 'canonicalShape', 'migrationPhase',
      'migrationJournalSha256', 'source', 'datasets',
    ]),
    'Source manifest',
  );
  if (manifest.canonicalShape !== CANONICAL_SHAPE) throw new Error('Canonical shape is invalid.');
  if (manifest.migrationPhase !== MIGRATION_PHASE) throw new Error('Migration phase is not all.');
  const journal = migrationJournalEvidence();
  if (manifest.migrationJournalSha256 !== journal.sha256) {
    throw new Error('Source manifest was made for a different migration journal.');
  }
  assertSha256(manifest.source?.databaseFingerprint, 'Source database fingerprint');
  assertUtcTimestamp(manifest.source?.capturedAt, 'Source capture timestamp');
  if (manifest.schemaVersion === 1) {
    assertExactObjectFields(
      manifest.source,
      new Set([
        'databaseName', 'databaseFingerprint', 'capturedAt', 'writesFrozen',
        'freezeAttestationFile', 'freezeAttestationSha256', 'freezePublicKeyFile',
        'freezePublicKeySha256', 'readConcern',
        'readPreference', 'transactionallyConsistent', 'totalCount',
      ]),
      'Source manifest source',
    );
    assertSha256(manifest.source?.freezeAttestationSha256, 'Freeze attestation digest');
    assertSha256(manifest.source?.freezePublicKeySha256, 'Freeze public key digest');
    if (
      manifest.source?.writesFrozen !== true ||
      manifest.source?.readConcern !== 'snapshot' ||
      manifest.source?.readPreference !== 'primary' ||
      manifest.source?.transactionallyConsistent !== true
    ) {
      throw new Error('Source consistency/freeze proof is incomplete.');
    }
    if (
      manifest.source.freezeAttestationFile !== 'freeze-attestation.json' ||
      manifest.source.freezePublicKeyFile !== 'freeze-public-key.pem'
    ) {
      throw new Error('Source freeze evidence paths are not fixed.');
    }
    const bundledAttestationPath = join(bundle, manifest.source.freezeAttestationFile);
    const bundledPublicKeyPath = join(bundle, manifest.source.freezePublicKeyFile);
    const bundledAttestationBytes = readFileSync(bundledAttestationPath, 'utf8');
    const bundledAttestation = readJsonFile(bundledAttestationPath, 'Bundled freeze attestation');
    if (`${canonicalJson(bundledAttestation)}\n` !== bundledAttestationBytes) {
      throw new Error('Bundled freeze attestation is not canonical JSON.');
    }
    const bundledPublicKey = readFileSync(bundledPublicKeyPath, 'utf8');
    const verifiedFreeze = verifyFreezeAttestation(bundledAttestation, bundledPublicKey, {
      databaseName: manifest.source.databaseName,
      databaseFingerprint: manifest.source.databaseFingerprint,
    });
    if (
      verifiedFreeze.attestationSha256 !== manifest.source.freezeAttestationSha256 ||
      verifiedFreeze.publicKeySha256 !== manifest.source.freezePublicKeySha256
    ) {
      throw new Error('Bundled freeze evidence digests differ from the source manifest.');
    }
  } else {
    assertExactObjectFields(
      manifest.source,
      new Set([
        'evidenceKind', 'databaseName', 'databaseFingerprint', 'capturedAt',
        'sourceRetired', 'archiveFile', 'archiveObjectUri', 'archiveSha256',
        'archiveObjectVersionId', 'archiveBytes', 'archiveCreatedByMongoVersion',
        'archiveCensusFile', 'archiveCensusSha256',
        'recoveryImage', 'networkIsolatedRestore', 'exactNamespaceCensus',
        'totalCount',
      ]),
      'Archive source manifest',
    );
    const profile = FINAL_BACKUP_RECOVERY_PROFILE;
    if (
      manifest.source.evidenceKind !== ARCHIVE_SOURCE_KIND ||
      manifest.source.databaseName !== profile.databaseName ||
      manifest.source.capturedAt !== profile.objectLastModified ||
      manifest.source.sourceRetired !== true ||
      manifest.source.archiveFile !== 'source.archive.gz' ||
      manifest.source.archiveObjectUri !== profile.objectUri ||
      manifest.source.archiveObjectVersionId !== profile.objectVersionId ||
      manifest.source.archiveSha256 !== profile.archiveSha256 ||
      manifest.source.archiveBytes !== profile.archiveBytes ||
      manifest.source.archiveCreatedByMongoVersion !== profile.archiveCreatedByMongoVersion ||
      manifest.source.archiveCensusFile !== 'archive-census.json' ||
      manifest.source.recoveryImage !== profile.recoveryImage ||
      manifest.source.networkIsolatedRestore !== true ||
      manifest.source.exactNamespaceCensus !== true
    ) {
      throw new Error('Archive source manifest differs from the pinned final backup profile.');
    }
    assertSha256(manifest.source.archiveSha256, 'Archive source digest');
    assertSha256(manifest.source.archiveCensusSha256, 'Archive census digest');
    const archiveCensusPath = join(bundle, manifest.source.archiveCensusFile);
    const archiveCensusBytes = readFileSync(archiveCensusPath, 'utf8');
    const archiveCensus = readJsonFile(archiveCensusPath, 'Archive recovery census');
    if (`${canonicalJson(archiveCensus)}\n` !== archiveCensusBytes) {
      throw new Error('Archive recovery census is not canonical JSON.');
    }
    const archiveEvidence = validateArchiveRecoveryEvidence({
      archivePath: join(bundle, manifest.source.archiveFile),
      census: archiveCensus,
      profile,
    });
    if (
      archiveEvidence.databaseFingerprint !== manifest.source.databaseFingerprint ||
      archiveEvidence.censusSha256 !== manifest.source.archiveCensusSha256 ||
      archiveEvidence.totalCount !== manifest.source.totalCount
    ) {
      throw new Error('Archive evidence differs from the source manifest.');
    }
  }
  if (!Array.isArray(manifest.datasets) || manifest.datasets.length !== BACKEND_DATASETS.length) {
    throw new Error('Source manifest does not contain exactly 26 datasets.');
  }

  const canonicalRowsByDataset = {};
  let total = 0;
  for (let index = 0; index < BACKEND_DATASETS.length; index += 1) {
    const fixed = BACKEND_DATASETS[index];
    const entry = manifest.datasets[index];
    assertExactObjectFields(
      entry,
      new Set([
        'name', 'sourceCollection', 'sourceFile', 'targetTables', 'sourceCount',
        'sourceSha256', 'sourceIdentitySha256', 'tables',
      ]),
      `Source dataset '${fixed.name}'`,
    );
    const expectedFile = `source/${fixed.name}.ndjson`;
    if (
      entry?.name !== fixed.name ||
      entry?.sourceCollection !== fixed.name ||
      entry?.sourceFile !== expectedFile
    ) {
      throw new Error(`Dataset position ${index} is not the fixed '${fixed.name}' binding.`);
    }
    const loaded = readCanonicalNdjson(join(bundle, expectedFile), fixed.name);
    const evidence = evidenceForRows(loaded.rows, fixed.identity, fixed.name);
    if (loaded.bytes !== evidence.bytes) throw new Error(`Dataset '${fixed.name}' is not canonical/sorted.`);
    assertEvidenceFields(entry, 'source', evidence, `Dataset '${fixed.name}' source`);
    if (
      manifest.schemaVersion === 2 &&
      entry.sourceCount !== FINAL_BACKUP_RECOVERY_PROFILE.expectedCounts[fixed.name]
    ) {
      throw new Error(`Dataset '${fixed.name}' count differs from the pinned final backup.`);
    }
    const plannedRows = await targetRowsForDataset(fixed.name, evidence.rows);
    const plannedTables = await tableEvidenceForDataset(fixed.name, plannedRows, 'source');
    if (!Array.isArray(entry.tables) || entry.tables.length !== plannedTables.length) {
      throw new Error(`Dataset '${fixed.name}' has the wrong table evidence count.`);
    }
    for (let tableIndex = 0; tableIndex < plannedTables.length; tableIndex += 1) {
      const planned = plannedTables[tableIndex];
      const recorded = entry.tables[tableIndex];
      assertExactObjectFields(
        recorded,
        new Set(['name', 'sourceCount', 'sourceSha256', 'sourceIdentitySha256']),
        `Source dataset '${fixed.name}' table ${tableIndex}`,
      );
      if (recorded?.name !== planned.name) {
        throw new Error(`Dataset '${fixed.name}' table ${tableIndex} is not '${planned.name}'.`);
      }
      assertEvidenceFields(recorded, 'source', {
        count: planned.sourceCount,
        sha256: planned.sourceSha256,
        identitySha256: planned.sourceIdentitySha256,
      }, `Dataset '${fixed.name}' table '${planned.name}' source`);
    }
    if (!exactStrings(entry.targetTables, plannedTables.map((table) => table.name))) {
      throw new Error(`Dataset '${fixed.name}' target table mapping differs.`);
    }
    canonicalRowsByDataset[fixed.name] = evidence.rows;
    total += evidence.count;
  }
  if (total < 1 || manifest.source.totalCount !== total) {
    throw new Error('Source total count is empty or inconsistent.');
  }
  return {
    manifest,
    manifestSha256: sha256(manifestBytes),
    canonicalRowsByDataset,
  };
}

function migrationsDirectory() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = join(repositoryRoot, 'packages/backend/src/db/postgres/migrations');
  const compiled = join(repositoryRoot, 'packages/backend/dist/src/db/postgres/migrations');
  const selected = existsSync(join(source, 'meta/_journal.json')) ? source : compiled;
  if (!existsSync(join(selected, 'meta/_journal.json'))) {
    throw new Error('The pinned backend migration journal is absent.');
  }
  return selected;
}

export function migrationJournalEvidence() {
  const folder = migrationsDirectory();
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'));
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('The backend migration journal is empty.');
  }
  const migrations = journal.entries.map((entry, index) => {
    if (
      entry.idx !== index ||
      typeof entry.tag !== 'string' ||
      !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
      !Number.isSafeInteger(entry.when)
    ) {
      throw new Error(`Migration journal entry ${index} is malformed.`);
    }
    const filename = `${entry.tag}.sql`;
    return { tag: entry.tag, when: entry.when, sql: readFileSync(join(folder, filename), 'utf8') };
  });
  return { journal, migrations, sha256: sha256({ journal, migrations }) };
}

export function assertMigrationPhase(phase) {
  if (phase !== MIGRATION_PHASE) {
    throw new Error(`Initial backend cutover requires --phase=${MIGRATION_PHASE}.`);
  }
}

export function assertTargetCountsEmpty(counts) {
  for (const dataset of BACKEND_DATASETS) {
    for (const tableKey of dataset.tableKeys) {
      const count = counts[tableKey];
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`Target count for '${tableKey}' is absent or invalid.`);
      }
      if (count !== 0) throw new Error(`Target table '${tableKey}' is not empty (${count} rows).`);
    }
  }
}

export async function allTableMetadata() {
  const seen = new Set();
  const result = [];
  for (const dataset of BACKEND_DATASETS) {
    for (const [tableIndex, tableKey] of dataset.tableKeys.entries()) {
      if (seen.has(tableKey)) continue;
      seen.add(tableKey);
      const metadata = await tableMetadata(tableKey);
      if (metadata.tableName !== dataset.targetTables[tableIndex]) {
        throw new Error(
          `Fixed table '${dataset.targetTables[tableIndex]}' resolved as '${metadata.tableName}'.`,
        );
      }
      result.push({
        tableKey,
        table: metadata.table,
        tableName: metadata.tableName,
        columns: metadata.columns,
        identity: TABLE_IDENTITIES[tableKey],
      });
    }
  }
  if (result.length !== 27) throw new Error(`Expected 27 PostgreSQL tables, found ${result.length}.`);
  return result;
}

export async function buildTargetPlan(canonicalRowsByDataset) {
  const rowsByTableKey = {};
  for (const dataset of BACKEND_DATASETS) {
    const rows = canonicalRowsByDataset[dataset.name];
    if (!Array.isArray(rows)) throw new Error(`Canonical dataset '${dataset.name}' is absent.`);
    const planned = await targetRowsForDataset(dataset.name, rows);
    const reconstructed = await canonicalRowsFromTarget(dataset.name, planned);
    const sourceEvidence = evidenceForRows(rows, dataset.identity, `${dataset.name} source plan`);
    const reconstructedEvidence = evidenceForRows(
      reconstructed,
      dataset.identity,
      `${dataset.name} reconstructed plan`,
    );
    if (
      sourceEvidence.count !== reconstructedEvidence.count ||
      sourceEvidence.sha256 !== reconstructedEvidence.sha256 ||
      sourceEvidence.identitySha256 !== reconstructedEvidence.identitySha256
    ) {
      throw new Error(`Dataset '${dataset.name}' cannot round-trip through the pinned PostgreSQL shape.`);
    }
    for (const tableKey of dataset.tableKeys) {
      if (rowsByTableKey[tableKey] !== undefined) {
        throw new Error(`Target table key '${tableKey}' was planned twice.`);
      }
      rowsByTableKey[tableKey] = planned[tableKey];
    }
  }
  validateRelationships(rowsByTableKey);
  return rowsByTableKey;
}

function identitySet(rows, field, tableKey) {
  const result = new Set();
  for (const [index, row] of rows.entries()) {
    const value = row[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${tableKey}[${index}].${field} is not an exact string identifier.`);
    }
    if (result.has(value)) throw new Error(`${tableKey} duplicates identity field '${field}'.`);
    result.add(value);
  }
  return result;
}

function rowIndex(rows, field) {
  return new Map(rows.map((row) => [row[field], row]));
}

function requireReference(row, field, targets, label, { optional = false } = {}) {
  const value = row[field];
  if (optional && (value === undefined || value === null)) return;
  if (typeof value !== 'string' || !targets.has(value)) {
    throw new Error(`${label}.${field} references an absent identifier.`);
  }
}

export function validateRelationships(rowsByTableKey) {
  const rows = (tableKey) => {
    const value = rowsByTableKey[tableKey];
    if (!Array.isArray(value)) throw new Error(`Target relationship plan lacks '${tableKey}'.`);
    return value;
  };
  const organizations = identitySet(rows('organizations'), 'organizationId', 'organizations');
  const applicationRows = rows('applications');
  const applications = identitySet(applicationRows, 'applicationId', 'applications');
  const applicationOrganizations = new Map();
  for (const [index, row] of applicationRows.entries()) {
    requireReference(row, 'organizationId', organizations, `applications[${index}]`);
    applicationOrganizations.set(row.applicationId, row.organizationId);
  }
  const caseRows = rows('cases');
  const reportRows = rows('reports');
  const decisionRows = rows('decisions');
  const cases = identitySet(caseRows, 'caseId', 'cases');
  const reports = identitySet(reportRows, 'reportId', 'reports');
  const decisions = identitySet(decisionRows, 'decisionId', 'decisions');
  const appealRows = rows('appeals');
  const appeals = identitySet(appealRows, 'appealId', 'appeals');
  const caseById = rowIndex(caseRows, 'caseId');
  const reportById = rowIndex(reportRows, 'reportId');
  const reviewers = identitySet(rows('reviewerProfiles'), 'reviewerId', 'reviewerProfiles');
  const draws = identitySet(rows('sortitionDraws'), 'drawId', 'sortitionDraws');
  const assignments = identitySet(rows('assignments'), 'assignmentId', 'assignments');
  const assignmentById = rowIndex(rows('assignments'), 'assignmentId');
  const drawById = rowIndex(rows('sortitionDraws'), 'drawId');
  const outboxEvents = identitySet(rows('outboxEvents'), 'eventId', 'outboxEvents');
  const endpoints = identitySet(rows('webhookEndpoints'), 'webhookEndpointId', 'webhookEndpoints');
  const deliveries = identitySet(rows('webhookDeliveries'), 'deliveryId', 'webhookDeliveries');
  const credentials = identitySet(
    rows('applicationCredentials'),
    'credentialId',
    'applicationCredentials',
  );
  const endpointById = rowIndex(rows('webhookEndpoints'), 'webhookEndpointId');
  const deliveryById = rowIndex(rows('webhookDeliveries'), 'deliveryId');
  const eventById = rowIndex(rows('outboxEvents'), 'eventId');
  const decisionById = rowIndex(decisionRows, 'decisionId');
  const credentialById = rowIndex(rows('applicationCredentials'), 'credentialId');
  const assignmentRowsById = rowIndex(rows('assignments'), 'assignmentId');
  const appealById = rowIndex(appealRows, 'appealId');

  const tenantStamped = [
    'appeals', 'appTrustSnapshots', 'applicationCredentials', 'assignments', 'auditEvents',
    'caseReports', 'cases', 'decisions', 'outboxEvents', 'policySets', 'reports',
    'reviews', 'sortitionDraws', 'usageCounters', 'webhookAttempts',
    'webhookDeliveries', 'webhookEndpoints', 'webhookSecrets',
  ];
  for (const tableKey of tenantStamped) {
    for (const [index, row] of rows(tableKey).entries()) {
      requireReference(row, 'applicationId', applications, `${tableKey}[${index}]`);
      requireReference(row, 'organizationId', organizations, `${tableKey}[${index}]`);
      if (applicationOrganizations.get(row.applicationId) !== row.organizationId) {
        throw new Error(`${tableKey}[${index}] has an organization/application ownership mismatch.`);
      }
    }
  }
  for (const [index, row] of rows('organizationMembers').entries()) {
    requireReference(row, 'organizationId', organizations, `organizationMembers[${index}]`);
  }
  for (const tableKey of ['reviewerPrincipalLinks', 'reviewerRelations']) {
    for (const [index, row] of rows(tableKey).entries()) {
      requireReference(row, 'reviewerId', reviewers, `${tableKey}[${index}]`);
      requireReference(row, 'applicationId', applications, `${tableKey}[${index}]`);
    }
  }
  for (const [index, row] of rows('staffAuditEvents').entries()) {
    requireReference(row, 'applicationId', applications, `staffAuditEvents[${index}]`, { optional: true });
  }
  for (const [index, row] of rows('reports').entries()) {
    requireReference(row, 'caseId', cases, `reports[${index}]`);
    if (caseById.get(row.caseId)?.applicationId !== row.applicationId) {
      throw new Error(`reports[${index}] points to a case in another application.`);
    }
  }
  for (const [index, row] of rows('auditEvents').entries()) {
    requireReference(row, 'actorCredentialId', credentials, `auditEvents[${index}]`, { optional: true });
    requireReference(row, 'reportId', reports, `auditEvents[${index}]`, { optional: true });
    requireReference(row, 'caseId', cases, `auditEvents[${index}]`, { optional: true });
    const credential = row.actorCredentialId == null ? undefined : credentialById.get(row.actorCredentialId);
    const report = row.reportId == null ? undefined : reportById.get(row.reportId);
    const targetCase = row.caseId == null ? undefined : caseById.get(row.caseId);
    for (const referenced of [credential, report, targetCase]) {
      if (
        referenced !== undefined &&
        (referenced.applicationId !== row.applicationId || referenced.organizationId !== row.organizationId)
      ) {
        throw new Error(`auditEvents[${index}] references a row in another tenant.`);
      }
    }
    if (report !== undefined && row.externalReportId != null && report.externalReportId !== row.externalReportId) {
      throw new Error(`auditEvents[${index}] does not match its report external identifier.`);
    }
  }
  for (const [index, row] of rows('caseReports').entries()) {
    requireReference(row, 'caseId', cases, `caseReports[${index}]`);
    requireReference(row, 'reportId', reports, `caseReports[${index}]`);
    const report = reportById.get(row.reportId);
    if (
      report?.caseId !== row.caseId ||
      report?.applicationId !== row.applicationId ||
      report?.organizationId !== row.organizationId ||
      report?.externalReportId !== row.externalReportId
    ) {
      throw new Error(`caseReports[${index}] does not match its report/case relationship.`);
    }
  }
  for (const [index, row] of rows('decisions').entries()) {
    requireReference(row, 'caseId', cases, `decisions[${index}]`);
    requireReference(row, 'supersedesDecisionId', decisions, `decisions[${index}]`, { optional: true });
    const targetCase = caseById.get(row.caseId);
    const superseded = row.supersedesDecisionId == null
      ? undefined
      : decisionById.get(row.supersedesDecisionId);
    if (
      targetCase?.applicationId !== row.applicationId ||
      targetCase?.organizationId !== row.organizationId ||
      (superseded !== undefined && (
        superseded.caseId !== row.caseId ||
        superseded.applicationId !== row.applicationId ||
        superseded.organizationId !== row.organizationId
      ))
    ) {
      throw new Error(`decisions[${index}] crosses a case or superseded-decision tenant.`);
    }
  }
  for (const [index, row] of appealRows.entries()) {
    requireReference(row, 'caseId', cases, `appeals[${index}]`);
    requireReference(row, 'supersededDecisionId', decisions, `appeals[${index}]`);
    requireReference(row, 'filedByCredentialId', credentials, `appeals[${index}]`);
    const targetCase = caseById.get(row.caseId);
    const superseded = decisionById.get(row.supersededDecisionId);
    const credential = credentialById.get(row.filedByCredentialId);
    if (
      targetCase?.applicationId !== row.applicationId ||
      targetCase?.organizationId !== row.organizationId ||
      superseded?.caseId !== row.caseId ||
      superseded?.applicationId !== row.applicationId ||
      superseded?.organizationId !== row.organizationId ||
      superseded?.revision !== row.supersededRevision ||
      credential?.applicationId !== row.applicationId ||
      credential?.organizationId !== row.organizationId
    ) {
      throw new Error(`appeals[${index}] does not match its case, decision and credential tenant.`);
    }
  }
  for (const [index, row] of rows('sortitionDraws').entries()) {
    requireReference(row, 'caseId', cases, `sortitionDraws[${index}]`);
    if (caseById.get(row.caseId)?.applicationId !== row.applicationId) {
      throw new Error(`sortitionDraws[${index}] points to a case in another application.`);
    }
  }
  for (const [index, row] of rows('assignments').entries()) {
    requireReference(row, 'caseId', cases, `assignments[${index}]`);
    requireReference(row, 'drawId', draws, `assignments[${index}]`);
    requireReference(row, 'reviewerId', reviewers, `assignments[${index}]`);
    requireReference(row, 'replacementAssignmentId', assignments, `assignments[${index}]`, { optional: true });
    const draw = drawById.get(row.drawId);
    if (
      draw?.caseId !== row.caseId ||
      draw?.caseRevision !== row.caseRevision ||
      draw?.applicationId !== row.applicationId
    ) {
      throw new Error(`assignments[${index}] does not match its draw/case relationship.`);
    }
  }
  for (const [index, row] of rows('reviews').entries()) {
    requireReference(row, 'caseId', cases, `reviews[${index}]`);
    requireReference(row, 'assignmentId', assignments, `reviews[${index}]`);
    requireReference(row, 'reviewerId', reviewers, `reviews[${index}]`);
    const assignment = assignmentById.get(row.assignmentId);
    if (
      assignment?.caseId !== row.caseId ||
      assignment?.caseRevision !== row.caseRevision ||
      assignment?.reviewerId !== row.reviewerId ||
      assignment?.applicationId !== row.applicationId ||
      assignment?.organizationId !== row.organizationId
    ) {
      throw new Error(`reviews[${index}] does not match its assignment relationship.`);
    }
  }
  for (const [index, row] of rows('reviewerAffinities').entries()) {
    requireReference(row, 'reviewerIdA', reviewers, `reviewerAffinities[${index}]`);
    requireReference(row, 'reviewerIdB', reviewers, `reviewerAffinities[${index}]`);
  }
  const outboxReferenceSets = {
    reportId: reports,
    caseId: cases,
    assignmentId: assignments,
    decisionId: decisions,
    appealId: appeals,
  };
  const outboxReferenceIndexes = {
    reportId: reportById,
    caseId: caseById,
    assignmentId: assignmentRowsById,
    decisionId: decisionById,
    appealId: appealById,
  };
  for (const [index, row] of rows('outboxEvents').entries()) {
    if (!plainObject(row.payload)) throw new Error(`outboxEvents[${index}].payload must be an object.`);
    assertExactObjectFields(
      row.payload,
      new Set(Object.keys(outboxReferenceSets)),
      `outboxEvents[${index}].payload`,
    );
    for (const [field, targets] of Object.entries(outboxReferenceSets)) {
      requireReference(row.payload, field, targets, `outboxEvents[${index}].payload`, { optional: true });
      const value = row.payload[field];
      const referenced = value == null ? undefined : outboxReferenceIndexes[field].get(value);
      if (
        referenced !== undefined &&
        (referenced.applicationId !== row.applicationId || referenced.organizationId !== row.organizationId)
      ) {
        throw new Error(`outboxEvents[${index}].payload.${field} references another tenant.`);
      }
    }
    const referencedCaseIds = [
      row.payload.caseId,
      reportById.get(row.payload.reportId)?.caseId,
      assignmentRowsById.get(row.payload.assignmentId)?.caseId,
      decisionById.get(row.payload.decisionId)?.caseId,
      appealById.get(row.payload.appealId)?.caseId,
    ].filter((caseId) => caseId !== undefined && caseId !== null);
    if (new Set(referencedCaseIds).size > 1) {
      throw new Error(`outboxEvents[${index}].payload references more than one case.`);
    }
  }
  for (const [index, row] of rows('webhookSecrets').entries()) {
    requireReference(row, 'webhookEndpointId', endpoints, `webhookSecrets[${index}]`);
    if (endpointById.get(row.webhookEndpointId)?.applicationId !== row.applicationId) {
      throw new Error(`webhookSecrets[${index}] points to an endpoint in another application.`);
    }
  }
  for (const [index, row] of rows('webhookDeliveries').entries()) {
    requireReference(row, 'webhookEndpointId', endpoints, `webhookDeliveries[${index}]`);
    requireReference(row, 'eventId', outboxEvents, `webhookDeliveries[${index}]`);
    if (
      endpointById.get(row.webhookEndpointId)?.applicationId !== row.applicationId ||
      eventById.get(row.eventId)?.applicationId !== row.applicationId
    ) {
      throw new Error(`webhookDeliveries[${index}] crosses an endpoint/event application.`);
    }
  }
  for (const [index, row] of rows('webhookAttempts').entries()) {
    requireReference(row, 'webhookEndpointId', endpoints, `webhookAttempts[${index}]`);
    requireReference(row, 'deliveryId', deliveries, `webhookAttempts[${index}]`);
    requireReference(row, 'eventId', outboxEvents, `webhookAttempts[${index}]`);
    if (
      endpointById.get(row.webhookEndpointId)?.applicationId !== row.applicationId ||
      deliveryById.get(row.deliveryId)?.applicationId !== row.applicationId ||
      eventById.get(row.eventId)?.applicationId !== row.applicationId
    ) {
      throw new Error(`webhookAttempts[${index}] crosses a delivery/endpoint/event application.`);
    }
  }
}

export function receiptIdentity({ sourceManifestSha256, targetDatabaseFingerprint, journalSha256 }) {
  return sha256({ sourceManifestSha256, targetDatabaseFingerprint, journalSha256 });
}

export function validateReceipt(receipt, expected) {
  if (receipt?.format !== RECEIPT_FORMAT || receipt?.schemaVersion !== 1) {
    throw new Error('Import receipt format/version is invalid.');
  }
  if (!['prepared', 'committed'].includes(receipt.state)) throw new Error('Import receipt state is invalid.');
  assertExactObjectFields(
    receipt,
    new Set([
      'format', 'schemaVersion', 'state', 'migrationPhase', 'emptyBeforeImport',
      'emptyCheckedAt', 'sourceManifestSha256', 'sourceDatabaseFingerprint',
      'targetDatabase', 'targetDatabaseFingerprint', 'migrationJournalSha256',
      'importIdentity', 'committedAt',
    ]),
    'Import receipt',
  );
  if (receipt.emptyBeforeImport !== true) throw new Error('Import receipt lacks the empty-target proof.');
  assertUtcTimestamp(receipt.emptyCheckedAt, 'Import receipt empty-check timestamp');
  if (receipt.state === 'committed') {
    assertUtcTimestamp(receipt.committedAt, 'Import receipt commit timestamp');
    if (Date.parse(receipt.committedAt) < Date.parse(receipt.emptyCheckedAt)) {
      throw new Error('Import receipt commit predates its empty-target check.');
    }
  }
  if (receipt.state === 'prepared' && receipt.committedAt !== undefined) {
    throw new Error('Prepared import receipt already has a commit timestamp.');
  }
  if (receipt.migrationPhase !== MIGRATION_PHASE) throw new Error('Import receipt phase is not all.');
  for (const [field, value] of Object.entries(expected)) {
    if (receipt[field] !== value) throw new Error(`Import receipt '${field}' does not match this operation.`);
  }
  const calculated = receiptIdentity({
    sourceManifestSha256: receipt.sourceManifestSha256,
    targetDatabaseFingerprint: receipt.targetDatabaseFingerprint,
    journalSha256: receipt.migrationJournalSha256,
  });
  if (receipt.importIdentity !== calculated) throw new Error('Import receipt identity digest is invalid.');
}

export function finalManifestViolations(manifest, expectedJournalSha256 = migrationJournalEvidence().sha256) {
  const violations = [];
  const capture = (action) => {
    try { action(); } catch (error) { violations.push(error instanceof Error ? error.message : String(error)); }
  };
  if (manifest?.format !== CUTOVER_FORMAT || ![1, 2].includes(manifest?.schemaVersion)) {
    violations.push('Manifest schema/version is invalid.');
  }
  capture(() => assertExactObjectFields(
    manifest,
    new Set([
      'format', 'schemaVersion', 'canonicalShape', 'migrationPhase',
      'migrationJournalSha256', 'source', 'target', 'datasets',
    ]),
    'Manifest',
  ));
  if (manifest?.schemaVersion === 1) {
    capture(() => assertExactObjectFields(
      manifest?.source,
      new Set([
        'databaseName', 'databaseFingerprint', 'capturedAt', 'writesFrozen',
        'freezeAttestationFile', 'freezeAttestationSha256', 'freezePublicKeyFile',
        'freezePublicKeySha256', 'readConcern',
        'readPreference', 'transactionallyConsistent', 'totalCount',
      ]),
      'Manifest source',
    ));
  } else if (manifest?.schemaVersion === 2) {
    capture(() => assertExactObjectFields(
      manifest?.source,
      new Set([
        'evidenceKind', 'databaseName', 'databaseFingerprint', 'capturedAt',
        'sourceRetired', 'archiveFile', 'archiveObjectUri', 'archiveSha256',
        'archiveObjectVersionId', 'archiveBytes', 'archiveCreatedByMongoVersion',
        'archiveCensusFile', 'archiveCensusSha256',
        'recoveryImage', 'networkIsolatedRestore', 'exactNamespaceCensus',
        'totalCount',
      ]),
      'Manifest archive source',
    ));
  }
  capture(() => assertExactObjectFields(
    manifest?.target,
    new Set([
      'databaseName', 'databaseFingerprint', 'checkedAt', 'migratorRole',
      'emptyBeforeImport', 'isolationLevel', 'schemaAndOwnerVerified',
      'migrationLedgerVerified', 'postgresCatalogSha256', 'totalCount',
      'importReceiptSha256',
    ]),
    'Manifest target',
  ));
  if (manifest?.canonicalShape !== CANONICAL_SHAPE) violations.push('Canonical shape is invalid.');
  if (manifest?.migrationPhase !== MIGRATION_PHASE) violations.push('Migration phase is not all.');
  if (manifest?.migrationJournalSha256 !== expectedJournalSha256) {
    violations.push('Migration journal digest differs from this checkout.');
  }
  capture(() => assertSha256(manifest?.source?.databaseFingerprint, 'Source database fingerprint'));
  if (manifest?.schemaVersion === 1) {
    capture(() => assertSha256(manifest?.source?.freezeAttestationSha256, 'Freeze attestation digest'));
    capture(() => assertSha256(manifest?.source?.freezePublicKeySha256, 'Freeze public key digest'));
  } else if (manifest?.schemaVersion === 2) {
    capture(() => assertSha256(manifest?.source?.archiveSha256, 'Archive source digest'));
    capture(() => assertSha256(manifest?.source?.archiveCensusSha256, 'Archive census digest'));
  }
  capture(() => assertSha256(manifest?.target?.databaseFingerprint, 'Target database fingerprint'));
  capture(() => assertSha256(manifest?.target?.postgresCatalogSha256, 'Target PostgreSQL catalog digest'));
  capture(() => assertSha256(manifest?.target?.importReceiptSha256, 'Import receipt digest'));
  if (manifest?.source?.databaseFingerprint === manifest?.target?.databaseFingerprint) {
    violations.push('Source and target database fingerprints are identical.');
  }
  if (
    typeof manifest?.source?.databaseName !== 'string' ||
    !/^[A-Za-z0-9_-]{1,63}$/.test(manifest.source.databaseName) ||
    typeof manifest?.target?.databaseName !== 'string' ||
    !/^[A-Za-z0-9_-]{1,63}$/.test(manifest.target.databaseName)
  ) {
    violations.push('Source or target database name is invalid.');
  }
  if (manifest?.schemaVersion === 1) {
    if (manifest?.source?.writesFrozen !== true) violations.push('Source writes were not frozen.');
    if (
      manifest?.source?.readConcern !== 'snapshot' ||
      manifest?.source?.readPreference !== 'primary' ||
      manifest?.source?.transactionallyConsistent !== true
    ) {
      violations.push('Source snapshot consistency evidence is invalid.');
    }
  } else if (manifest?.schemaVersion === 2) {
    const profile = FINAL_BACKUP_RECOVERY_PROFILE;
    if (
      manifest?.source?.evidenceKind !== ARCHIVE_SOURCE_KIND ||
      manifest?.source?.databaseName !== profile.databaseName ||
      manifest?.source?.databaseFingerprint !== archiveSourceFingerprint(profile) ||
      manifest?.source?.capturedAt !== profile.objectLastModified ||
      manifest?.source?.sourceRetired !== true ||
      manifest?.source?.archiveFile !== 'source.archive.gz' ||
      manifest?.source?.archiveObjectUri !== profile.objectUri ||
      manifest?.source?.archiveObjectVersionId !== profile.objectVersionId ||
      manifest?.source?.archiveSha256 !== profile.archiveSha256 ||
      manifest?.source?.archiveBytes !== profile.archiveBytes ||
      manifest?.source?.archiveCreatedByMongoVersion !== profile.archiveCreatedByMongoVersion ||
      manifest?.source?.archiveCensusFile !== 'archive-census.json' ||
      manifest?.source?.recoveryImage !== profile.recoveryImage ||
      manifest?.source?.networkIsolatedRestore !== true ||
      manifest?.source?.exactNamespaceCensus !== true
    ) {
      violations.push('Archive source differs from the pinned final backup profile.');
    }
  }
  if (manifest?.target?.emptyBeforeImport !== true) violations.push('Target was not proven empty.');
  if (manifest?.target?.migratorRole !== MIGRATOR_ROLE) violations.push('Target migrator role is invalid.');
  if (
    manifest?.target?.isolationLevel !== 'serializable' ||
    manifest?.target?.schemaAndOwnerVerified !== true ||
    manifest?.target?.migrationLedgerVerified !== true ||
    manifest?.target?.postgresCatalogSha256 !== EXPECTED_POSTGRES_CATALOG_SHA256
  ) {
    violations.push('Target transaction/schema/ledger evidence is invalid.');
  }
  capture(() => assertUtcTimestamp(manifest?.source?.capturedAt, 'Source capture timestamp'));
  capture(() => assertUtcTimestamp(manifest?.target?.checkedAt, 'Target check timestamp'));
  if (Date.parse(manifest?.target?.checkedAt) < Date.parse(manifest?.source?.capturedAt)) {
    violations.push('Target check predates source capture.');
  }
  if (!Array.isArray(manifest?.datasets) || manifest.datasets.length !== BACKEND_DATASETS.length) {
    violations.push('Manifest does not contain exactly 26 datasets.');
    return violations;
  }
  let sourceTotal = 0;
  let targetTotal = 0;
  let tableCount = 0;
  for (let index = 0; index < BACKEND_DATASETS.length; index += 1) {
    const fixed = BACKEND_DATASETS[index];
    const dataset = manifest.datasets[index];
    capture(() => assertExactObjectFields(
      dataset,
      new Set([
        'name', 'sourceCollection', 'sourceFile', 'targetTables', 'sourceCount',
        'sourceSha256', 'sourceIdentitySha256', 'targetCount', 'targetSha256',
        'targetIdentitySha256', 'tables',
      ]),
      `Dataset '${fixed.name}'`,
    ));
    if (dataset?.name !== fixed.name || dataset?.sourceCollection !== fixed.name) {
      violations.push(`Dataset position ${index} is not fixed '${fixed.name}'.`);
      continue;
    }
    if (dataset?.sourceFile !== `source/${fixed.name}.ndjson`) {
      violations.push(`Dataset '${fixed.name}' has the wrong source evidence path.`);
    }
    if (
      manifest?.schemaVersion === 2 &&
      dataset?.sourceCount !== FINAL_BACKUP_RECOVERY_PROFILE.expectedCounts[fixed.name]
    ) {
      violations.push(`Dataset '${fixed.name}' count differs from the pinned final backup.`);
    }
    if (!exactStrings(dataset.targetTables, fixed.targetTables)) {
      violations.push(`Dataset '${fixed.name}' has the wrong target table binding.`);
    }
    capture(() => assertEvidenceFields(dataset, 'source', undefined, `Dataset '${fixed.name}' source`));
    capture(() => assertEvidenceFields(dataset, 'target', undefined, `Dataset '${fixed.name}' target`));
    if (
      dataset.sourceCount !== dataset.targetCount ||
      dataset.sourceSha256 !== dataset.targetSha256 ||
      dataset.sourceIdentitySha256 !== dataset.targetIdentitySha256
    ) {
      violations.push(`Dataset '${fixed.name}' canonical evidence differs.`);
    }
    sourceTotal += Number.isSafeInteger(dataset.sourceCount) ? dataset.sourceCount : 0;
    targetTotal += Number.isSafeInteger(dataset.targetCount) ? dataset.targetCount : 0;
    if (!Array.isArray(dataset.tables) || dataset.tables.length !== fixed.tableKeys.length) {
      violations.push(`Dataset '${fixed.name}' has the wrong table evidence count.`);
      continue;
    }
    tableCount += dataset.tables.length;
    for (let tableIndex = 0; tableIndex < dataset.tables.length; tableIndex += 1) {
      const table = dataset.tables[tableIndex];
      capture(() => assertExactObjectFields(
        table,
        new Set([
          'name', 'sourceCount', 'sourceSha256', 'sourceIdentitySha256',
          'targetCount', 'targetSha256', 'targetIdentitySha256',
        ]),
        `Dataset '${fixed.name}' table ${tableIndex}`,
      ));
      if (table?.name !== fixed.targetTables[tableIndex]) {
        violations.push(`Dataset '${fixed.name}' table ${tableIndex} has the wrong identity.`);
      }
      if (!plainObject(table)) continue;
      capture(() => assertEvidenceFields(table, 'source', undefined, `Table '${table?.name}' source`));
      capture(() => assertEvidenceFields(table, 'target', undefined, `Table '${table?.name}' target`));
      if (
        table.sourceCount !== table.targetCount ||
        table.sourceSha256 !== table.targetSha256 ||
        table.sourceIdentitySha256 !== table.targetIdentitySha256
      ) {
        violations.push(`Table '${table?.name}' evidence differs.`);
      }
    }
  }
  if (sourceTotal < 1 || targetTotal !== sourceTotal) violations.push('Manifest totals are empty or differ.');
  if (
    manifest?.schemaVersion === 2 &&
    sourceTotal !== Object.values(FINAL_BACKUP_RECOVERY_PROFILE.expectedCounts)
      .reduce((sum, count) => sum + count, 0)
  ) {
    violations.push('Archive manifest total differs from the pinned final backup.');
  }
  if (manifest?.source?.totalCount !== sourceTotal || manifest?.target?.totalCount !== targetTotal) {
    violations.push('Manifest recorded totals differ from dataset totals.');
  }
  if (tableCount !== 27) violations.push(`Manifest has ${tableCount} target tables, not 27.`);
  return violations;
}

function sourceManifestProjection(finalManifest) {
  return {
    format: finalManifest.format,
    schemaVersion: finalManifest.schemaVersion,
    canonicalShape: finalManifest.canonicalShape,
    migrationPhase: finalManifest.migrationPhase,
    migrationJournalSha256: finalManifest.migrationJournalSha256,
    source: finalManifest.source,
    datasets: finalManifest.datasets.map((dataset) => ({
      name: dataset.name,
      sourceCollection: dataset.sourceCollection,
      sourceFile: dataset.sourceFile,
      targetTables: dataset.targetTables,
      sourceCount: dataset.sourceCount,
      sourceSha256: dataset.sourceSha256,
      sourceIdentitySha256: dataset.sourceIdentitySha256,
      tables: dataset.tables.map((table) => ({
        name: table.name,
        sourceCount: table.sourceCount,
        sourceSha256: table.sourceSha256,
        sourceIdentitySha256: table.sourceIdentitySha256,
      })),
    })),
  };
}

export async function verifyFinalManifestEvidence({ manifest, bundleDirectory, receiptPath }) {
  const violations = finalManifestViolations(manifest);
  if (violations.length > 0) {
    throw new Error(`Final manifest refused:\n${violations.map((entry) => `  - ${entry}`).join('\n')}`);
  }
  const sourceBundle = await loadAndVerifySourceBundle(bundleDirectory);
  if (canonicalJson(sourceManifestProjection(manifest)) !== canonicalJson(sourceBundle.manifest)) {
    throw new Error('Final manifest source evidence differs from the signed source bundle.');
  }
  const receiptFile = resolve(receiptPath);
  const receiptBytes = readFileSync(receiptFile, 'utf8');
  const receipt = readJsonFile(receiptFile, 'Import receipt');
  if (receiptBytes !== `${canonicalJson(receipt)}\n`) {
    throw new Error('Import receipt is not canonical JSON.');
  }
  validateReceipt(receipt, {
    sourceManifestSha256: sourceBundle.manifestSha256,
    sourceDatabaseFingerprint: sourceBundle.manifest.source.databaseFingerprint,
    targetDatabase: manifest.target.databaseName,
    targetDatabaseFingerprint: manifest.target.databaseFingerprint,
    migrationJournalSha256: sourceBundle.manifest.migrationJournalSha256,
  });
  if (receipt.state !== 'committed') throw new Error('Final evidence requires a committed import receipt.');
  if (Date.parse(receipt.emptyCheckedAt) < Date.parse(sourceBundle.manifest.source.capturedAt)) {
    throw new Error('Import receipt empty-target check predates the source snapshot.');
  }
  if (Date.parse(manifest.target.checkedAt) < Date.parse(receipt.committedAt)) {
    throw new Error('Final target reconciliation predates the committed import receipt.');
  }
  if (manifest.target.importReceiptSha256 !== sha256(receiptBytes)) {
    throw new Error('Final manifest import receipt digest differs from the committed receipt bytes.');
  }
  return { manifest, sourceBundle, receipt };
}

export { EMPTY_SHA256 };
