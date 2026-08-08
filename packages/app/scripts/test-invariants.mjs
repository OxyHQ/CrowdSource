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
    // The guard is the STORE's: only a backend knows what an open transaction
    // looks like. The error it throws still belongs to the shared half, so both
    // backends refuse the same mistake the same way.
    file: 'src/mongoose/store/outbox.ts',
    edits: [
      {
        find: `      if (!session.inTransaction()) {
        throw new ModerationOutboxTransactionError(event.eventId);
      }
`,
        replace: '',
      },
      /**
       * The import goes with it. Now that the error is DECLARED in the shared
       * half and IMPORTED by each store, deleting the guard alone leaves an
       * unused import and `noUnusedLocals` fails the mutated tree — which this
       * script correctly refuses to read as evidence about the guard. Deleting
       * both is also what removing the guard actually looks like.
       */
      {
        find: `import { ModerationOutboxTransactionError } from '../../outbox/service.js';\n`,
        replace: '',
      },
    ],
    absent: 'session.inTransaction()',
    test: 'src/__tests__/outboxTransactionCoupling.test.ts',
    // Renamed with the harness façade: the fixture hands out a bound enqueue
    // rather than a mongoose session, and the test title must not name a driver
    // once a second backend runs it. The script matches on this string, so a
    // stale one reports "the guard is still unproven" rather than passing.
    expects: 'throws ModerationOutboxTransactionError for a handle with no transaction open',
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
    file: 'src/mongoose/store/outbox.ts',
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
    file: 'src/mongoose/store/outbox.ts',
    edits: [
      { find: `            createdAt: event.now,\n            updatedAt: event.now,\n`, replace: '' },
      { find: `{ upsert: true, session, timestamps: false }`, replace: `{ upsert: true, session }` },
    ],
    // The full options literal, not the bare flag: the flag also appears in the
    // doc comment above, so a substring marker would report "still present" for
    // a mutation that applied perfectly.
    absent: '{ upsert: true, session, timestamps: false }',
    test: 'src/__tests__/outboxTransactionCoupling.test.ts',
    expects: 'leaves an existing row completely untouched on a repeated enqueue',
  },
  {
    /**
     * `enforcedAt` claiming an effect that never landed. The normal case in
     * `observe` mode and the permanent case for an application with no sanction
     * primitive, so a regression here writes a false audit trail on every
     * decided report rather than on an edge case.
     */
    name: 'enforcedAt is stamped for an action that was only recorded',
    file: 'src/decision.ts',
    edits: [
      {
        find: `            at: outcomes.some(
              (outcome) =>
                effectiveAction(outcome) === enforcedAction &&
                outcome.result === 'applied',
            )
              ? new Date()
              : null,`,
        replace: `            at: new Date(),`,
      },
    ],
    absent: `outcome.result === 'applied'`,
    test: 'src/__tests__/reviewOnlyApplication.test.ts',
    expects: 'records the decision, and never claims an effect it did not have',
  },
  {
    /**
     * The reversal lookup reading a row whose effect never happened. The obvious
     * test of this cannot fail — see the file's own comment — so the mutation is
     * the only thing that proves the arrangement in it is load-bearing.
     */
    name: 'a reversal reads the newest row instead of the newest APPLIED row',
    file: 'src/mongoose/store/enforcement.ts',
    edits: [
      {
        find: `          action: { $in: [...actions] },
          applied: true,
        })`,
        replace: `          action: { $in: [...actions] },
        })`,
      },
    ],
    absent: `          action: { $in: [...actions] },\n          applied: true,`,
    test: 'src/__tests__/enforcementReversal.test.ts',
    expects: 'reads the applied row, not the newer recorded-only one',
  },
  {
    /**
     * The report falling back to the PLANNED action instead of the effective
     * one. Silent by construction: the plan is subject-blind, so the label is
     * wrong only for subjects no lever can act on — which for some applications
     * is most of them.
     */
    name: 'the report records the planned action instead of the effective one',
    file: 'src/decision.ts',
    edits: [
      {
        find: `      outcomes.map(effectiveAction),`,
        replace: `      outcomes.map((outcome) => outcome.action),`,
      },
    ],
    absent: 'outcomes.map(effectiveAction)',
    test: 'src/__tests__/fullLoop.test.ts',
    expects: 'uses the effective action for a subject no lever can act on',
  },
  {
    /**
     * A reversal that declares several actions but queries only one. Silent for
     * any application whose levers are exercised one at a time, and wrong
     * exactly when two of them applied — which is when a reversal matters most.
     */
    name: 'a multi-action reversal reads only the first declared action',
    file: 'src/mongoose/store/enforcement.ts',
    edits: [
      { find: '          action: { $in: [...actions] },', replace: '          action: actions[0],' },
    ],
    absent: '$in: [...actions]',
    test: 'src/__tests__/enforcementReversal.test.ts',
    expects: 'reads the most recent applied row across the whole declared set',
  },
  {
    /**
     * A correction that undoes only the FIRST reversible action. Found in
     * Mention as `unlabel_sensitive` — fully implemented, mode-gated, and
     * reachable from nothing — and present here too. The object comes back
     * visible and stays labelled forever: the appeal succeeded, the warning
     * never lifts, and nothing errors.
     */
    name: 'a correction plans only the first declared restore',
    file: 'src/enforcement/planner.ts',
    edits: [
      {
        find: `  const missing = restoreActions(declared).filter(
    (action) => !planned.some((entry) => entry.action === action),
  );`,
        replace: `  const missing = restoreActions(declared)
    .slice(0, 1)
    .filter((action) => !planned.some((entry) => entry.action === action));`,
      },
    ],
    absent: 'const missing = restoreActions(declared).filter(',
    test: 'src/__tests__/enforcementReversal.test.ts',
    expects: 'lifts a label as well as a restriction',
  },
  {
    /**
     * The dedup asking "is ANY restore already planned?" instead of asking per
     * action. Reached only by a `no_violation` whose recommendation is itself a
     * restore — so it is invisible on every other decision, and on those it
     * suppresses the whole set.
     */
    name: 'the restore dedup suppresses the whole set instead of one action',
    file: 'src/enforcement/planner.ts',
    edits: [
      {
        find: `  const missing = restoreActions(declared).filter(
    (action) => !planned.some((entry) => entry.action === action),
  );`,
        replace: `  const declaredRestores = restoreActions(declared);
  const missing = planned.some((entry) => declaredRestores.includes(entry.action))
    ? []
    : declaredRestores;`,
      },
    ],
    absent: '(action) => !planned.some((entry) => entry.action === action),',
    test: 'src/__tests__/enforcementReversal.test.ts',
    expects: 'still adds the other reversal when one is already recommended',
  },
  {
    /**
     * The inversion guard removed. It is the one configuration error here that
     * no type can catch and that does not fail at runtime — it applies a
     * punishment on an accepted appeal, which succeeds.
     */
    name: 'an inverted restoreAction is accepted at construction',
    file: 'src/enforcement/planner.ts',
    edits: [
      {
        find: '  if (inverted.length > 0) throw new ModerationRestoreDirectionError(inverted);',
        replace: '  void inverted;',
      },
    ],
    absent: 'throw new ModerationRestoreDirectionError(inverted)',
    test: 'src/__tests__/configTypeErgonomics.test.ts',
    expects: 'throws when restoreAction names the actions being undone',
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
