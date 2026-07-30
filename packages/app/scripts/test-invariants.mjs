#!/usr/bin/env bun

/**
 * The two invariants are guarded by tests that can actually fail.
 *
 * A test that cannot distinguish success from failure is worse than no test,
 * and both invariants here are exactly the shape that produces one: the happy
 * path passes whether or not the guard exists, so a green suite proves nothing
 * on its own. This script breaks each guard on purpose and asserts that the
 * named test goes red.
 *
 * Three things are checked per mutation, in this order, because a mutation that
 * did not apply produces a FALSE GREEN that looks identical to a real pass:
 *
 *   1. the edit actually landed — the file changed, and the marker it removes is
 *      really gone;
 *   2. the mutated tree still TYPE-CHECKS — otherwise the test "failed" because
 *      it did not compile, which proves nothing about the guard;
 *   3. the test run fails, and its output NAMES the test that is supposed to
 *      catch this.
 *
 * The original files are restored from an in-memory copy and verified by hash,
 * whatever happens — including on a thrown error or a Ctrl-C.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{name: string, file: string, edits: {find: string, replace: string}[], absent: string, test: string, expects: string}[]} */
const MUTATIONS = [
  {
    name: 'the outbox may be written outside a transaction',
    file: 'src/outbox/service.ts',
    edits: [
      {
        find: `      if (!session.inTransaction()) {
        throw new ModerationOutboxTransactionError(enqueueInput.eventId);
      }
`,
        replace: '',
      },
    ],
    absent: 'session.inTransaction()',
    test: 'src/__tests__/outboxTransactionCoupling.test.ts',
    expects: 'throws ModerationOutboxTransactionError for a session with no transaction open',
  },
  {
    name: 'the webhook router is mounted behind express.json()',
    file: 'src/__tests__/support/webhookApp.ts',
    edits: [
      {
        find: `  if (options.jsonParser === 'before') app.use(express.json());`,
        replace: `  if (options.jsonParser !== 'after') app.use(express.json());`,
      },
    ],
    absent: `options.jsonParser === 'before'`,
    test: 'src/__tests__/webhookRawBody.test.ts',
    expects: 'reaches the moderation router with req.body still undefined',
  },
  {
    /**
     * The bug that actually shipped in the reference implementation: explicit
     * timestamps AND Mongoose's own, so one path arrives under two operators and
     * the server refuses the write. Intake's transaction aborts with it, so this
     * is not a degradation — no report can be filed at all.
     */
    name: 'the enqueue lets Mongoose add its timestamps on top of the explicit ones',
    file: 'src/outbox/service.ts',
    edits: [{ find: `{ upsert: true, session, timestamps: false }`, replace: `{ upsert: true, session }` }],
    // The full options literal, not the bare flag: the flag also appears in the
    // doc comment above, so a substring marker would report "still present" for
    // a mutation that applied perfectly.
    absent: '{ upsert: true, session, timestamps: false }',
    test: 'src/__tests__/outboxTransactionCoupling.test.ts',
    expects: 'stores both when the reported type has a subject provider',
  },
  {
    /**
     * The subtler half, and the reason the fix is `timestamps: false` rather
     * than dropping the explicit fields. Letting Mongoose own the timestamps
     * type-checks, passes every happy path, and quietly turns a repeated enqueue
     * into a real write that conflicts with a live lease.
     */
    name: 'the enqueue writes on a repeated event instead of being a no-op',
    file: 'src/outbox/service.ts',
    edits: [
      { find: `            createdAt: now,\n            updatedAt: now,\n`, replace: '' },
      { find: `{ upsert: true, session, timestamps: false }`, replace: `{ upsert: true, session }` },
    ],
    // The full options literal, not the bare flag: the flag also appears in the
    // doc comment above, so a substring marker would report "still present" for
    // a mutation that applied perfectly.
    absent: '{ upsert: true, session, timestamps: false }',
    test: 'src/__tests__/outboxTransactionCoupling.test.ts',
    expects: 'leaves an existing row completely untouched on a repeated enqueue',
  },
];

const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** @param {string[]} argv */
function run(argv) {
  return spawnSync(argv[0], argv.slice(1), {
    cwd: packageRoot,
    encoding: 'utf8',
    env: process.env,
  });
}

const originals = new Map();
function restoreAll() {
  for (const [path, content] of originals) {
    writeFileSync(path, content, 'utf8');
    if (digest(readFileSync(path, 'utf8')) !== digest(content)) {
      console.error(`FATAL: could not restore ${path}. Check it with git before continuing.`);
      process.exitCode = 1;
    }
  }
  originals.clear();
}
process.on('exit', restoreAll);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

const failures = [];
let checked = 0;

for (const mutation of MUTATIONS) {
  const path = resolve(packageRoot, mutation.file);
  const original = readFileSync(path, 'utf8');
  originals.set(path, original);

  console.log(`\n── mutation: ${mutation.name}`);

  // --- 1. every edit landed.
  let mutated = original;
  let editFailure;
  for (const edit of mutation.edits) {
    if (!mutated.includes(edit.find)) {
      editFailure =
        `${mutation.file}: the text this mutation replaces is no longer present ` +
        `(${JSON.stringify(edit.find.slice(0, 60))}). The guard may have been ` +
        'refactored — update this script rather than deleting it.';
      break;
    }
    const next = mutated.replace(edit.find, edit.replace);
    if (next === mutated) {
      editFailure = `${mutation.file}: one replacement changed nothing.`;
      break;
    }
    mutated = next;
  }
  if (editFailure !== undefined) {
    failures.push(editFailure);
    writeFileSync(path, original, 'utf8');
    originals.delete(path);
    continue;
  }
  /**
   * Every early exit below RESTORES before moving on. Leaving a half-applied
   * mutation on disk makes the next case run against a tree it did not choose,
   * and its "the text is no longer present" complaint then blames the wrong
   * mutation — which is how a script that exists to prevent false results starts
   * producing them.
   */
  writeFileSync(path, mutated, 'utf8');
  const onDisk = readFileSync(path, 'utf8');
  if (digest(onDisk) === digest(original)) {
    failures.push(`${mutation.file}: the write did not take effect on disk.`);
    writeFileSync(path, original, 'utf8');
    originals.delete(path);
    continue;
  }
  if (onDisk.includes(mutation.absent)) {
    failures.push(
      `${mutation.file}: '${mutation.absent}' is still present after the mutation, ` +
        'so whatever failed next did not fail because the guard was gone.',
    );
    writeFileSync(path, original, 'utf8');
    originals.delete(path);
    continue;
  }
  console.log(`   applied (${original.length} → ${onDisk.length} bytes)`);

  // --- 2. the mutated tree still type-checks.
  const typecheck = run(['bun', 'run', 'lint']);
  if (typecheck.status !== 0) {
    failures.push(
      `${mutation.file}: the mutated tree does not type-check, so a red test would ` +
        `prove nothing about the guard.\n${typecheck.stdout}${typecheck.stderr}`,
    );
    writeFileSync(path, original, 'utf8');
    continue;
  }
  console.log('   type-clean');

  // --- 3. the test fails, and names itself.
  const result = run([
    'node',
    '../../node_modules/vitest/vitest.mjs',
    'run',
    mutation.test,
    '--reporter=verbose',
  ]);
  const output = `${result.stdout}${result.stderr}`;

  if (result.status === 0) {
    failures.push(
      `${mutation.file}: the suite still PASSED with the guard removed. ` +
        `'${mutation.expects}' does not test what it claims to.`,
    );
  } else if (!output.includes(mutation.expects)) {
    failures.push(
      `${mutation.file}: the suite failed, but its output never names ` +
        `'${mutation.expects}' — so something else broke and the guard is still unproven.`,
    );
  } else {
    console.log(`   caught by: ${mutation.expects}`);
    checked += 1;
  }

  writeFileSync(path, original, 'utf8');
  originals.delete(path);
}

restoreAll();

// --- Vacuity floor: a traversal that silently checked nothing must not pass.
if (checked !== MUTATIONS.length) {
  failures.push(
    `only ${checked} of ${MUTATIONS.length} mutations were confirmed caught.`,
  );
}

if (failures.length > 0) {
  console.error('\nInvariant guards are not proven:\n');
  for (const failure of failures) console.error(`  • ${failure}\n`);
  process.exit(1);
}

console.log(
  `\nThe guards hold: ${checked} mutations applied, type-checked, and caught.`,
);
