#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  readJsonFile,
  verifyFinalManifestEvidence,
} from './crowdsource-backend-cutover-lib.mjs';
import {
  importPostgres,
  reexportPostgres,
  targetFingerprintForUrl,
} from './crowdsource-backend-cutover-postgres.mjs';

const sensitiveValues = new Set();
const legacyConnectionEnvironment = [
  'CROWDSOURCE_CUTOVER_SOURCE_URL',
  'CROWDSOURCE_CUTOVER_POSTGRES_URL',
];

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (command === undefined || command.startsWith('--')) throw new Error('A cutover command is required.');
  const options = {};
  for (const token of tokens) {
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/.exec(token);
    if (match === null || match[2].length === 0) throw new Error(`Invalid option '${token}'.`);
    const key = match[1];
    if (options[key] !== undefined) throw new Error(`Option '--${key}' was supplied twice.`);
    options[key] = match[2];
  }
  return { command, options };
}

function exactOptions(options, required) {
  const allowed = new Set(required);
  const extra = Object.keys(options).find((key) => !allowed.has(key));
  if (extra !== undefined) throw new Error(`Unknown option '--${extra}'.`);
  for (const key of required) {
    if (options[key] === undefined) throw new Error(`Required option '--${key}' is absent.`);
  }
}

function rejectLegacyConnectionEnvironment() {
  if (legacyConnectionEnvironment.some((name) => process.env[name] !== undefined)) {
    throw new Error('Database connection URLs must be supplied only on standard input, never through environment variables.');
  }
}

function requiredConnectionFromStdin() {
  if (process.stdin.isTTY) {
    throw new Error('A database connection URL is required on standard input.');
  }
  let value;
  try {
    value = readFileSync(0, 'utf8');
  } catch {
    throw new Error('The database connection URL could not be read from standard input.');
  }
  value = value.replace(/\r?\n$/, '');
  if (value.length === 0 || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error('Standard input must contain exactly one database connection URL.');
  }
  sensitiveValues.add(value);
  return value;
}

function safeErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of sensitiveValues) message = message.split(value).join('[redacted connection URL]');
  return message.replace(
    /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?):\/\/[^\s'"`]+/giu,
    '[redacted connection URL]',
  );
}

async function importTarget(options) {
  exactOptions(options, ['bundle', 'receipt', 'target-database', 'expected-target-fingerprint', 'phase']);
  const result = await importPostgres({
    bundleDirectory: options.bundle,
    receiptPath: options.receipt,
    connectionUrl: requiredConnectionFromStdin(),
    targetDatabase: options['target-database'],
    expectedTargetFingerprint: options['expected-target-fingerprint'],
    phase: options.phase,
  });
  process.stdout.write(
    result.idempotent
      ? 'PostgreSQL already contains the exact reconciled import; receipt confirmed.\n'
      : 'PostgreSQL import committed and reconciled in the guarded transaction.\n',
  );
}

async function reexportTarget(options) {
  exactOptions(options, [
    'bundle',
    'receipt',
    'output-manifest',
    'target-database',
    'expected-target-fingerprint',
    'phase',
  ]);
  await reexportPostgres({
    bundleDirectory: options.bundle,
    receiptPath: options.receipt,
    outputManifestPath: options['output-manifest'],
    connectionUrl: requiredConnectionFromStdin(),
    targetDatabase: options['target-database'],
    expectedTargetFingerprint: options['expected-target-fingerprint'],
    phase: options.phase,
  });
  process.stdout.write(`Final reconciled manifest written to '${resolve(options['output-manifest'])}'.\n`);
}

function fingerprintTarget(options) {
  exactOptions(options, ['target-database']);
  const connectionUrl = requiredConnectionFromStdin();
  const value = targetFingerprintForUrl(connectionUrl, options['target-database']);
  process.stdout.write(`${value}\n`);
}

async function verifyManifest(options) {
  exactOptions(options, ['manifest', 'bundle', 'receipt']);
  await verifyFinalManifestEvidence({
    manifest: readJsonFile(options.manifest, 'Final manifest'),
    bundleDirectory: options.bundle,
    receiptPath: options.receipt,
  });
  process.stdout.write('Final manifest reconciles 26 datasets and 27 PostgreSQL tables.\n');
}

async function main() {
  rejectLegacyConnectionEnvironment();
  const { command, options } = parseArguments(process.argv.slice(2));
  switch (command) {
    case 'fingerprint-target': fingerprintTarget(options); break;
    case 'import-postgres': await importTarget(options); break;
    case 'reexport-postgres': await reexportTarget(options); break;
    case 'verify-manifest': await verifyManifest(options); break;
    default: throw new Error(`Unknown cutover command '${command}'.`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`CrowdSource backend cutover refused: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
