#!/usr/bin/env bun

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  ARCHIVE_CENSUS_FORMAT,
  BACKEND_DATASETS,
  FINAL_BACKUP_RECOVERY_PROFILE,
  assertMongoRecoveryKernelSupported,
  canonicalJson,
  createArchivedSourceBundle,
  readJsonFile,
  validateArchiveRecoveryEvidence,
} from './crowdsource-backend-cutover-lib.mjs';

const forbiddenEnvironment = [
  'CROWDSOURCE_CUTOVER_SOURCE_URL',
  'CROWDSOURCE_CUTOVER_POSTGRES_URL',
  'DATABASE_URL',
  'MIGRATOR_DATABASE_URL',
  'MONGODB_URI',
  'MONGO_URI',
];
const dockerRoutingEnvironment = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
];

function dockerEnvironment() {
  const environment = {};
  for (const name of ['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'TMPDIR', 'LANG']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function parseArguments(argv) {
  const options = {};
  for (const token of argv) {
    const match = /^--(archive|output)=(.+)$/.exec(token);
    if (match === null) throw new Error(`Invalid archive recovery option '${token}'.`);
    if (options[match[1]] !== undefined) throw new Error(`Option '--${match[1]}' was supplied twice.`);
    options[match[1]] = match[2];
  }
  if (Object.keys(options).length !== 2 || options.archive === undefined || options.output === undefined) {
    throw new Error('Archive recovery requires exactly --archive and --output.');
  }
  return options;
}

function runDocker(arguments_, options = {}) {
  const result = spawnSync('docker', arguments_, {
    encoding: options.input === undefined ? 'utf8' : undefined,
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    env: dockerEnvironment(),
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Isolated archive recovery step '${arguments_[0]}' failed.`);
  }
  return result;
}

function assertLocalRecoveryDocker() {
  if (dockerRoutingEnvironment.some((name) => process.env[name] !== undefined)) {
    throw new Error('Archive recovery refuses Docker endpoint overrides.');
  }
  const context = runDocker(['context', 'show']).stdout.trim();
  if (context !== 'default') throw new Error('Archive recovery requires the local default Docker context.');
  const endpoint = runDocker([
    'context', 'inspect', 'default', '--format', '{{(index .Endpoints "docker").Host}}',
  ]).stdout.trim();
  if (endpoint !== 'unix:///var/run/docker.sock') {
    throw new Error('Archive recovery requires the local Docker Unix socket.');
  }
  const kernelRelease = runDocker(['info', '--format', '{{.KernelVersion}}']).stdout.trim();
  assertMongoRecoveryKernelSupported(kernelRelease);
}

function waitForMongo(containerName, uid, gid) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync(
      'docker',
      [
        'exec', '--user', `${uid}:${gid}`, containerName,
        'mongosh', '--host', '127.0.0.1', '--port', '27017', '--quiet',
        '--eval', 'quit(db.adminCommand({ping:1}).ok === 1 ? 0 : 1)',
      ],
      { encoding: 'utf8', timeout: 2_000, env: dockerEnvironment() },
    );
    if (probe.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error('Network-isolated Mongo recovery container did not become ready.');
}

function readRawDocuments(rawDirectory, census) {
  const documents = {};
  const counts = new Map(census.collections.map((entry) => [entry.name, entry.count]));
  for (const dataset of BACKEND_DATASETS) {
    const filename = join(rawDirectory, `${dataset.name}.extended-json.ndjson`);
    const bytes = readFileSync(filename, 'utf8');
    if (bytes.length > 0 && !bytes.endsWith('\n')) {
      throw new Error(`Recovered dataset '${dataset.name}' lacks a final newline.`);
    }
    const lines = bytes.length === 0 ? [] : bytes.slice(0, -1).split('\n');
    if (counts.get(dataset.name) !== lines.length) {
      throw new Error(`Recovered dataset '${dataset.name}' differs from its archive census.`);
    }
    documents[dataset.name] = lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Recovered dataset '${dataset.name}' line ${index + 1} is invalid JSON.`);
      }
    });
  }
  return documents;
}

async function recover(options) {
  if (forbiddenEnvironment.some((name) => process.env[name] !== undefined)) {
    throw new Error('Archive recovery refuses every database connection environment variable.');
  }
  if (process.platform !== 'linux') {
    throw new Error('Pinned MongoDB archive recovery requires an approved Linux runner.');
  }
  assertLocalRecoveryDocker();
  const archive = resolve(options.archive);
  const output = resolve(options.output);
  if (!existsSync(archive)) {
    throw new Error('Pinned archive input is absent or not a regular file.');
  }
  let archiveDescriptor;
  let archiveBytes;
  try {
    archiveDescriptor = openSync(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    const archiveStat = fstatSync(archiveDescriptor);
    if (!archiveStat.isFile()) throw new Error('Pinned archive input is absent or not a regular file.');
    if ((archiveStat.mode & 0o077) !== 0) {
      throw new Error('Pinned archive input must be private (mode 0600 or stricter).');
    }
    archiveBytes = readFileSync(archiveDescriptor);
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('Pinned archive input must not be a symbolic link.');
    throw error;
  } finally {
    if (archiveDescriptor !== undefined) closeSync(archiveDescriptor);
  }
  if (existsSync(output)) throw new Error(`Output '${output}' already exists.`);
  const outputParent = dirname(output);
  if (!existsSync(outputParent) || !statSync(outputParent).isDirectory()) {
    throw new Error(`Output parent '${outputParent}' does not exist.`);
  }

  // Verify the object bytes before starting any parser or database process.
  const expectedCensus = {
    format: ARCHIVE_CENSUS_FORMAT,
    databaseName: FINAL_BACKUP_RECOVERY_PROFILE.databaseName,
    collections: BACKEND_DATASETS.map((dataset) => ({
      name: dataset.name,
      count: FINAL_BACKUP_RECOVERY_PROFILE.expectedCounts[dataset.name],
    })),
  };
  const archiveEvidence = validateArchiveRecoveryEvidence({
    archiveBytes,
    census: expectedCensus,
    profile: FINAL_BACKUP_RECOVERY_PROFILE,
  });

  const rawDirectory = mkdtempSync(join(outputParent, '.crowdsource-archive-recovery-'));
  chmodSync(rawDirectory, 0o700);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const containerName = `crowdsource-archive-recovery-${randomBytes(12).toString('hex')}`;
  const extractor = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'crowdsource-backend-recover-archive.mongosh.js',
  );
  let containerCreated = false;
  let recoveryError;
  let cleanupFailed = false;
  try {
    runDocker([
      'run', '--detach', '--pull=never', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
      '--memory=512m', '--cpus=1', '--user', `${uid}:${gid}`,
      '--tmpfs', `/data/db:rw,noexec,nosuid,nodev,size=64m,uid=${uid},gid=${gid},mode=0700`,
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=16m,uid=${uid},gid=${gid},mode=0700`,
      '--volume', `${rawDirectory}:/evidence:rw`,
      '--volume', `${extractor}:/tool/recover.js:ro`,
      '--name', containerName,
      '--entrypoint', 'mongod',
      FINAL_BACKUP_RECOVERY_PROFILE.recoveryImage,
      '--dbpath', '/data/db', '--bind_ip', '127.0.0.1', '--port', '27017',
      '--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false',
    ]);
    containerCreated = true;
    waitForMongo(containerName, uid, gid);
    runDocker(
      [
        'exec', '--interactive', '--user', `${uid}:${gid}`, containerName,
        'mongorestore', '--host', '127.0.0.1', '--port', '27017',
        '--archive', '--gzip', '--quiet', '--stopOnError', '--noIndexRestore',
        '--numParallelCollections=1',
      ],
      { input: archiveEvidence.archiveBytes, timeout: 15 * 60_000 },
    );
    runDocker([
      'exec', '--user', `${uid}:${gid}`,
      '--env', `CROWDSOURCE_RECOVERY_DATABASE=${FINAL_BACKUP_RECOVERY_PROFILE.databaseName}`,
      '--env', 'CROWDSOURCE_RECOVERY_RAW_DIRECTORY=/evidence',
      '--env', `CROWDSOURCE_RECOVERY_DATASETS=${canonicalJson(BACKEND_DATASETS.map((dataset) => dataset.name))}`,
      '--env', `CROWDSOURCE_RECOVERY_EXPECTED_COUNTS=${canonicalJson(FINAL_BACKUP_RECOVERY_PROFILE.expectedCounts)}`,
      containerName,
      'mongosh', '--host', '127.0.0.1', '--port', '27017', '--quiet',
      '--file', '/tool/recover.js',
    ]);

    const census = readJsonFile(join(rawDirectory, 'archive-census.json'), 'Archive recovery census');
    validateArchiveRecoveryEvidence({
      archiveBytes: archiveEvidence.archiveBytes,
      census,
      profile: FINAL_BACKUP_RECOVERY_PROFILE,
    });
    const rawDocumentsByDataset = readRawDocuments(rawDirectory, census);
    await createArchivedSourceBundle({
      outputDirectory: output,
      rawDocumentsByDataset,
      archiveBytes: archiveEvidence.archiveBytes,
      census,
      rawDirectory,
      profile: FINAL_BACKUP_RECOVERY_PROFILE,
    });
  } catch (error) {
    process.stderr.write(`Private recovery evidence remains at '${rawDirectory}' with mode 0700.\n`);
    recoveryError = error;
  } finally {
    if (containerCreated) {
      const cleanup = spawnSync('docker', ['rm', '--force', containerName], {
        encoding: 'utf8',
        timeout: 30_000,
        env: dockerEnvironment(),
      });
      cleanupFailed = cleanup.error !== undefined || cleanup.status !== 0;
    }
  }
  if (cleanupFailed) throw new Error('Archive recovery could not remove its exact isolated container.');
  if (recoveryError !== undefined) throw recoveryError;
  process.stdout.write(`Verified final-backup source bundle created at '${output}'.\n`);
}

if (import.meta.main) {
  recover(parseArguments(process.argv.slice(2))).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`CrowdSource archive recovery refused: ${message}\n`);
    process.exitCode = 1;
  });
}
