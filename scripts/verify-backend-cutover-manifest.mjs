#!/usr/bin/env bun

import { resolve } from 'node:path';

import {
  BACKEND_DATASETS,
  finalManifestViolations,
  readJsonFile,
  verifyFinalManifestEvidence,
} from './crowdsource-backend-cutover-lib.mjs';

export { BACKEND_DATASETS };
export const backendCutoverManifestViolations = finalManifestViolations;

if (import.meta.main) {
  const [manifestPath, bundleDirectory, receiptPath] = process.argv.slice(2);
  if (
    manifestPath === undefined ||
    bundleDirectory === undefined ||
    receiptPath === undefined ||
    process.argv.length !== 5
  ) {
    process.stderr.write(
      'Usage: bun scripts/verify-backend-cutover-manifest.mjs <manifest.json> <bundle-directory> <receipt.json>\n',
    );
    process.exit(2);
  }
  try {
    await verifyFinalManifestEvidence({
      manifest: readJsonFile(resolve(manifestPath), 'Final manifest'),
      bundleDirectory: resolve(bundleDirectory),
      receiptPath: resolve(receiptPath),
    });
    process.stdout.write(
      'Backend cutover manifest reconciles signed source evidence, committed receipt, 26 datasets and 27 tables.\n',
    );
  } catch (error) {
    process.stderr.write(
      `Backend cutover manifest refused: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
