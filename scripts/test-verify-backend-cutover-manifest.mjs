#!/usr/bin/env bun

import {
  BACKEND_DATASETS,
  backendCutoverManifestViolations,
} from './verify-backend-cutover-manifest.mjs';

const emptyDigest = `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
const manifest = {
  format: 'crowdsource-backend-cutover/v1',
  canonicalShape: 'crowdsource-backend-domain/v1',
  migrationJournalSha256: `sha256:${'3'.repeat(64)}`,
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
  datasets: BACKEND_DATASETS.map(({ name, targetTables }) => ({
    name,
    sourceCollection: name,
    targetTables: [...targetTables],
    sourceCount: 0,
    sourceSha256: emptyDigest,
    sourceIdentitySha256: emptyDigest,
    targetCount: 0,
    targetSha256: emptyDigest,
    targetIdentitySha256: emptyDigest,
  })),
};

function mustCatch(mutator, violation) {
  const changed = structuredClone(manifest);
  mutator(changed);
  if (!backendCutoverManifestViolations(changed).includes(violation)) {
    throw new Error(`The backend manifest gate accepted mutation: ${violation}`);
  }
}

if (backendCutoverManifestViolations(manifest).length !== 0) {
  throw new Error('The valid backend manifest control was refused.');
}

mustCatch(
  (changed) => {
    changed.source.writesFrozen = false;
  },
  'source writes were not frozen',
);
mustCatch(
  (changed) => {
    changed.target.emptyBeforeImport = false;
  },
  'target was not proven empty',
);
mustCatch(
  (changed) => {
    changed.datasets[0].targetCount = 1;
  },
  "dataset 'appeals' count mismatch",
);
mustCatch(
  (changed) => {
    changed.datasets[0].targetIdentitySha256 = `sha256:${'4'.repeat(64)}`;
  },
  "dataset 'appeals' identity digest mismatch",
);
mustCatch(
  (changed) => {
    changed.datasets[0].targetTables = ['wrong_table'];
  },
  "dataset 'appeals' has the wrong target tables",
);
mustCatch(
  (changed) => {
    changed.datasets.pop();
  },
  "dataset 'webhook_secrets' is missing",
);
mustCatch(
  (changed) => {
    changed.datasets.push({ ...changed.datasets[0], name: 'surprise' });
  },
  "dataset 'surprise' is not in the fixed backend mapping",
);

process.stdout.write(
  'The backend cutover manifest gate catches freeze, empty-target, mapping, count and ID mutations.\n',
);
