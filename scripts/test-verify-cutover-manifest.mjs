#!/usr/bin/env bun

import { cutoverManifestViolations } from './verify-cutover-manifest.mjs';

const emptyDigest = `sha256:${'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}`;
const manifest = {
  format: 'crowdsource-app-cutover/v1',
  source: {
    capturedAt: '2026-09-02T00:00:00.000Z',
    databaseFingerprint: `sha256:${'1'.repeat(64)}`,
    writesFrozen: true,
  },
  target: {
    checkedAt: '2026-09-02T00:01:00.000Z',
    databaseFingerprint: `sha256:${'2'.repeat(64)}`,
    emptyBeforeImport: true,
  },
  datasets: [
    {
      name: 'empty_control',
      sourceCount: 0,
      sourceSha256: emptyDigest,
      targetCount: 0,
      targetSha256: emptyDigest,
    },
  ],
};

if (cutoverManifestViolations(manifest).length !== 0) {
  throw new Error('The valid manifest control was refused.');
}

const populatedTarget = structuredClone(manifest);
populatedTarget.target.emptyBeforeImport = false;
if (!cutoverManifestViolations(populatedTarget).includes('target was not proven empty')) {
  throw new Error('The manifest gate accepted a target that was not proven empty.');
}

const countMismatch = structuredClone(manifest);
countMismatch.datasets[0].targetCount = 1;
if (!cutoverManifestViolations(countMismatch).includes("dataset 'empty_control' count mismatch")) {
  throw new Error('The manifest gate accepted a count mismatch.');
}

const digestMismatch = structuredClone(manifest);
digestMismatch.datasets[0].targetSha256 = `sha256:${'3'.repeat(64)}`;
if (!cutoverManifestViolations(digestMismatch).includes("dataset 'empty_control' digest mismatch")) {
  throw new Error('The manifest gate accepted a digest mismatch.');
}

const nonUtcTimestamp = structuredClone(manifest);
nonUtcTimestamp.source.capturedAt = '2026-09-02 00:00:00';
if (!cutoverManifestViolations(nonUtcTimestamp).includes('source timestamp is invalid')) {
  throw new Error('The manifest gate accepted a non-UTC timestamp.');
}

process.stdout.write('The cutover manifest gate catches timestamp, empty-target and reconciliation mutations.\n');
