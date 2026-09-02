#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * The exact legacy collection -> PostgreSQL table mapping. It is data rather
 * than name derivation so a rename cannot silently redirect a cutover.
 */
export const BACKEND_DATASETS = Object.freeze([
  { name: 'appeals', targetTables: ['appeals'] },
  { name: 'app_trust_snapshots', targetTables: ['app_trust_snapshots'] },
  { name: 'application_credentials', targetTables: ['application_credentials'] },
  { name: 'applications', targetTables: ['applications'] },
  { name: 'assignments', targetTables: ['assignments'] },
  { name: 'audit_events', targetTables: ['audit_events'] },
  { name: 'case_reports', targetTables: ['case_reports'] },
  { name: 'cases', targetTables: ['cases'] },
  { name: 'decisions', targetTables: ['decisions'] },
  { name: 'organization_members', targetTables: ['organization_members'] },
  { name: 'organizations', targetTables: ['organizations'] },
  { name: 'outbox_events', targetTables: ['outbox_events'] },
  { name: 'policy_sets', targetTables: ['policy_sets'] },
  { name: 'reports', targetTables: ['reports'] },
  { name: 'reviewer_affinities', targetTables: ['reviewer_affinities'] },
  {
    name: 'reviewer_profiles',
    targetTables: ['reviewer_profiles', 'reviewer_principal_links'],
  },
  { name: 'reviewer_relations', targetTables: ['reviewer_relations'] },
  { name: 'reviews', targetTables: ['reviews'] },
  { name: 'sortition_draws', targetTables: ['sortition_draws'] },
  { name: 'staff_audit_events', targetTables: ['staff_audit_events'] },
  { name: 'trust_safety_staff', targetTables: ['trust_safety_staff'] },
  { name: 'usage_counters', targetTables: ['usage_counters'] },
  { name: 'webhook_attempts', targetTables: ['webhook_attempts'] },
  { name: 'webhook_deliveries', targetTables: ['webhook_deliveries'] },
  { name: 'webhook_endpoints', targetTables: ['webhook_endpoints'] },
  { name: 'webhook_secrets', targetTables: ['webhook_secrets'] },
]);

function validTimestamp(value) {
  return typeof value === 'string' && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function backendCutoverManifestViolations(manifest) {
  const violations = [];
  if (manifest?.format !== 'crowdsource-backend-cutover/v1') violations.push('unknown format');
  if (manifest?.canonicalShape !== 'crowdsource-backend-domain/v1') {
    violations.push('unknown canonical shape');
  }
  if (manifest?.source?.writesFrozen !== true) violations.push('source writes were not frozen');
  if (manifest?.target?.emptyBeforeImport !== true) violations.push('target was not proven empty');
  if (!validTimestamp(manifest?.source?.capturedAt)) violations.push('source timestamp is invalid');
  if (!validTimestamp(manifest?.target?.checkedAt)) violations.push('target timestamp is invalid');
  if (!SHA256.test(manifest?.source?.databaseFingerprint ?? '')) {
    violations.push('source database fingerprint is invalid');
  }
  if (!SHA256.test(manifest?.target?.databaseFingerprint ?? '')) {
    violations.push('target database fingerprint is invalid');
  }
  if (!SHA256.test(manifest?.migrationJournalSha256 ?? '')) {
    violations.push('migration journal digest is invalid');
  }
  if (
    manifest?.source?.databaseFingerprint !== undefined &&
    manifest.source.databaseFingerprint === manifest?.target?.databaseFingerprint
  ) {
    violations.push('source and target database fingerprints are identical');
  }

  if (!Array.isArray(manifest?.datasets)) {
    violations.push('datasets must be an array');
    return violations;
  }

  const expectedByName = new Map(BACKEND_DATASETS.map((dataset) => [dataset.name, dataset]));
  const seen = new Set();
  for (const dataset of manifest.datasets) {
    const name = dataset?.name;
    if (typeof name !== 'string' || name.length === 0) {
      violations.push('a dataset has no stable name');
      continue;
    }
    if (seen.has(name)) violations.push(`dataset '${name}' is duplicated`);
    seen.add(name);

    const expected = expectedByName.get(name);
    if (expected === undefined) {
      violations.push(`dataset '${name}' is not in the fixed backend mapping`);
      continue;
    }
    if (dataset.sourceCollection !== name) {
      violations.push(`dataset '${name}' has the wrong source collection`);
    }
    if (!sameStrings(dataset.targetTables, expected.targetTables)) {
      violations.push(`dataset '${name}' has the wrong target tables`);
    }

    for (const side of ['source', 'target']) {
      const count = dataset[`${side}Count`];
      const digest = dataset[`${side}Sha256`];
      const identityDigest = dataset[`${side}IdentitySha256`];
      if (!Number.isSafeInteger(count) || count < 0) {
        violations.push(`dataset '${name}' has an invalid ${side} count`);
      }
      if (!SHA256.test(digest ?? '')) {
        violations.push(`dataset '${name}' has an invalid ${side} digest`);
      }
      if (!SHA256.test(identityDigest ?? '')) {
        violations.push(`dataset '${name}' has an invalid ${side} identity digest`);
      }
    }
    if (dataset.sourceCount !== dataset.targetCount) {
      violations.push(`dataset '${name}' count mismatch`);
    }
    if (dataset.sourceSha256 !== dataset.targetSha256) {
      violations.push(`dataset '${name}' digest mismatch`);
    }
    if (dataset.sourceIdentitySha256 !== dataset.targetIdentitySha256) {
      violations.push(`dataset '${name}' identity digest mismatch`);
    }
  }

  for (const expected of BACKEND_DATASETS) {
    if (!seen.has(expected.name)) violations.push(`dataset '${expected.name}' is missing`);
  }
  return violations;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write('Usage: bun scripts/verify-backend-cutover-manifest.mjs <manifest.json>\n');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const violations = backendCutoverManifestViolations(manifest);
  if (violations.length > 0) {
    process.stderr.write(
      `Backend cutover manifest refused:\n${violations.map((entry) => `  - ${entry}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    'Backend cutover manifest reconciles the fixed mapping, counts, content and identities.\n',
  );
}
