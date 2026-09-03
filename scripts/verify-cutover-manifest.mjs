#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function validTimestamp(value) {
  return typeof value === 'string' && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

export function cutoverManifestViolations(manifest) {
  const violations = [];
  if (manifest?.format !== 'crowdsource-app-cutover/v1') violations.push('unknown format');
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
  if (
    manifest?.source?.databaseFingerprint !== undefined &&
    manifest.source.databaseFingerprint === manifest?.target?.databaseFingerprint
  ) {
    violations.push('source and target database fingerprints are identical');
  }

  if (!Array.isArray(manifest?.datasets) || manifest.datasets.length === 0) {
    violations.push('datasets must be a non-empty array');
    return violations;
  }

  const names = new Set();
  for (const dataset of manifest.datasets) {
    if (typeof dataset?.name !== 'string' || dataset.name.length === 0) {
      violations.push('a dataset has no stable name');
      continue;
    }
    if (names.has(dataset.name)) violations.push(`dataset '${dataset.name}' is duplicated`);
    names.add(dataset.name);
    for (const side of ['source', 'target']) {
      const count = dataset[`${side}Count`];
      const digest = dataset[`${side}Sha256`];
      if (!Number.isSafeInteger(count) || count < 0) {
        violations.push(`dataset '${dataset.name}' has an invalid ${side} count`);
      }
      if (!SHA256.test(digest ?? '')) {
        violations.push(`dataset '${dataset.name}' has an invalid ${side} digest`);
      }
    }
    if (dataset.sourceCount !== dataset.targetCount) {
      violations.push(`dataset '${dataset.name}' count mismatch`);
    }
    if (dataset.sourceSha256 !== dataset.targetSha256) {
      violations.push(`dataset '${dataset.name}' digest mismatch`);
    }
  }
  return violations;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write('Usage: bun scripts/verify-cutover-manifest.mjs <manifest.json>\n');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const violations = cutoverManifestViolations(manifest);
  if (violations.length > 0) {
    process.stderr.write(`Cutover manifest refused:\n${violations.map((entry) => `  - ${entry}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('Cutover manifest reconciles counts, digests and empty-target evidence.\n');
}
