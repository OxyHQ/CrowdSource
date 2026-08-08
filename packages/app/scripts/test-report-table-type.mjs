#!/usr/bin/env bun

/**
 * The adopter's report table really is gated by the compiler.
 *
 * `postgresReportStore` takes a table it did not define — the only store that
 * does — so `ModerationReportTable` is the one type standing between an adopter
 * who forgot a column and a runtime failure on their first delivery. This script
 * proves that gate exists, in both directions, by compiling two fixture packages
 * and reading what `tsc` says about each.
 *
 * ## Why a script rather than a type test
 *
 * The natural spelling is `@ts-expect-error` beside a deliberately-wrong call, and
 * the repo rules forbid it — for good reason: it suppresses whatever error occurs,
 * including one from a completely different mistake. A separate compilation is the
 * only way to assert "this FAILS, and the failure names the thing we broke".
 *
 * ## Both halves are required
 *
 * The healthy fixture alone passes when the type has collapsed to something
 * `any`-shaped that checks nothing. The broken fixture alone passes when the
 * fixture is broken for an unrelated reason — a typo in an import would do it —
 * which is why this reads the compiler's OUTPUT and not only its exit code.
 *
 * ## What the gate does NOT catch, stated so nobody assumes otherwise
 *
 * Every member of `ModerationReportTable` is a bare `PgColumn`, so a column
 * present under the right NAME but declared with the wrong TYPE — `text` where the
 * store writes a `Date` — compiles clean. The DDL, `postgresSchema.test.ts`'s
 * exact column-name assertions, and the store's own round-trip tests are what
 * cover that half. This gate answers presence, nothing more.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The fixture lives INSIDE the package, because it imports the package's own
 * sources by relative path and must resolve the same `node_modules` the package
 * does. `tsconfig.json`'s `include` is `src/**` only, so nothing here is visible
 * to `bun run lint`, and `files` in `package.json` is `dist` plus `src`, so
 * nothing here can reach a tarball either.
 */
const FIXTURE_PREFIX = resolve(packageRoot, '.report-table-type-');

const COMMON_HEAD = `
import { pgTable, text } from 'drizzle-orm/pg-core';
import {
  moderationReportColumns,
  moderationReportTableExtras,
} from '../src/postgres/reportColumns.js';
import { postgresReportStore } from '../src/postgres/store/reports.js';
import type { ModerationPgHandle } from '../src/postgres/store/transaction.js';
import type { ModerationReportFields } from '../src/types.js';

const options = { reportedTypes: ['widget'], categories: ['spam'] };

interface AdopterReport extends ModerationReportFields {
  legacyStatus: string;
}

declare const db: ModerationPgHandle;
`;

/** An adopter's table composed the documented way. Must compile. */
const HEALTHY = `${COMMON_HEAD}
export const reports = pgTable(
  'reports',
  {
    ...moderationReportColumns(options),
    legacyStatus: text('legacy_status').notNull().default('pending'),
  },
  moderationReportTableExtras(options),
);

export const store = postgresReportStore<AdopterReport>({ db, reportTable: reports });
`;

/**
 * The same table with ONE column removed. Must fail at the store call.
 *
 * The extras callback is deliberately omitted here: it also requires every column,
 * so leaving it in would produce a second error and the assertion below could pass
 * on the wrong one.
 */
const BROKEN = `${COMMON_HEAD}
const { decisionRevision, ...withoutRevision } = moderationReportColumns(options);
void decisionRevision;

export const reports = pgTable('reports', {
  ...withoutRevision,
  legacyStatus: text('legacy_status').notNull().default('pending'),
});

export const store = postgresReportStore<AdopterReport>({ db, reportTable: reports });
`;

const TSCONFIG = JSON.stringify(
  {
    extends: '../tsconfig.json',
    compilerOptions: {
      noEmit: true,
      composite: false,
      incremental: false,
      declaration: false,
      declarationMap: false,
      types: ['node'],
      rootDir: '..',
    },
    include: ['./fixture.ts'],
  },
  null,
  2,
);

/** @param {string} source @returns {Promise<{ status: number, output: string, directory: string }>} */
async function compile(source) {
  const directory = await mkdtemp(FIXTURE_PREFIX);
  try {
    await writeFile(resolve(directory, 'fixture.ts'), source, 'utf8');
    await writeFile(resolve(directory, 'tsconfig.json'), `${TSCONFIG}\n`, 'utf8');
    const run = Bun.spawnSync({
      cmd: ['node', resolve(packageRoot, '../../node_modules/typescript/bin/tsc'), '-p', directory],
      cwd: packageRoot,
    });
    const decoder = new TextDecoder();
    return {
      status: run.exitCode,
      output: `${decoder.decode(run.stdout)}${decoder.decode(run.stderr)}`,
      directory,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const failures = [];

const healthy = await compile(HEALTHY);
if (healthy.status !== 0) {
  failures.push(
    'a table composed from moderationReportColumns() does NOT compile, so the gate ' +
      `refuses a correct adopter:\n${healthy.output}`,
  );
}

const broken = await compile(BROKEN);
if (broken.status === 0) {
  failures.push(
    'a table MISSING decisionRevision compiles clean. ModerationReportTable is not ' +
      'gating anything: an adopter who forgets a column this package queries would ' +
      'find out at runtime, on their first decision.',
  );
} else if (!broken.output.includes('decisionRevision')) {
  failures.push(
    'the broken fixture failed, but the compiler never named `decisionRevision` — so ' +
      `it broke for some other reason and the gate is still unproven:\n${broken.output}`,
  );
} else if (!broken.output.includes('fixture.ts')) {
  failures.push(
    `the broken fixture failed without naming its own file:\n${broken.output}`,
  );
}

/** No fixture directory may survive a run, including the failing one. */
const leftovers = (await readdir(packageRoot)).filter((entry) =>
  entry.startsWith('.report-table-type-'),
);
if (leftovers.length > 0) {
  failures.push(`fixture directories were left behind: ${leftovers.join(', ')}`);
}

if (failures.length > 0) {
  console.error('The report-table type gate is not proven:\n');
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}

console.log(
  'The report-table type gate holds: a complete table compiles, a table missing ' +
    '`decisionRevision` does not, and the compiler names it.',
);
