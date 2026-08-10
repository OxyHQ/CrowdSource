import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MIGRATIONS_FOLDER,
  isDryRun,
  readMigratorDatabaseUrl,
  readPhase,
} from '../db/migrate';

/**
 * The migration runner's decisions, without a process around them.
 *
 * `scripts/migrate.ts` is a thin wrapper over `runBackendMigrations`, so what is
 * worth asserting is what this module decides: which credential, which phase,
 * which folder, and — the one that matters most — what it does when the
 * credential it needs is absent.
 *
 * The APPLY path is covered elsewhere and better: `support/postgresTestDatabase.ts`
 * calls `runBackendMigrations` for every real-database test file, so the folder
 * resolution, the `--target-database` guard and the phase parsing are all
 * exercised against a real server dozens of times per run rather than only here.
 */

describe('the migrator credential', () => {
  it('reads MIGRATOR_DATABASE_URL', () => {
    expect(
      readMigratorDatabaseUrl({ MIGRATOR_DATABASE_URL: 'postgres://m@host/db' }),
    ).toBe('postgres://m@host/db');
  });

  it('trims it, so a copy-pasted secret with a trailing newline still works', () => {
    expect(
      readMigratorDatabaseUrl({ MIGRATOR_DATABASE_URL: '  postgres://m@host/db\n' }),
    ).toBe('postgres://m@host/db');
  });

  /**
   * The refusal this module exists for, and the assertion is on the ABSENCE of a
   * fallback rather than on the message.
   *
   * `DATABASE_URL` is supplied here deliberately: it is exactly the value a
   * fallback would reach for, and it is the application role — which owns
   * nothing. Against a correctly provisioned two-role database that fallback
   * fails loudly on a permission error, which is survivable. Against a
   * SINGLE-role database, which is how every other Oxy database in the estate is
   * provisioned, it SUCCEEDS: the migration applies, the deploy is green, and
   * every table ends up owned by the role the application connects as. A table's
   * owner is exempt from its own row-security policies, so isolation is enabled,
   * listed in `pg_policies`, and enforcing nothing. Nothing errors. No read is
   * wrong. This throw is the only thing between that and production.
   */
  it('refuses to fall back to DATABASE_URL when its own variable is unset', () => {
    expect(() =>
      readMigratorDatabaseUrl({ DATABASE_URL: 'postgres://crowdsource_app@host/db' }),
    ).toThrow(/MIGRATOR_DATABASE_URL is unset/);
  });

  it('treats a blank value as unset rather than as an empty connection string', () => {
    expect(() => readMigratorDatabaseUrl({ MIGRATOR_DATABASE_URL: '   ' })).toThrow(
      /MIGRATOR_DATABASE_URL is unset/,
    );
  });
});

describe('the deploy phase', () => {
  it('defaults to all when no flag is given', () => {
    expect(readPhase([])).toBe('all');
    expect(readPhase(['--target-database=crowdsource'])).toBe('all');
  });

  it.each(['pre', 'post', 'all'])('accepts --phase=%s', (phase) => {
    expect(readPhase([`--phase=${phase}`])).toBe(phase);
  });

  /**
   * A typo must not fall back to `all`. `all` applies every pending migration,
   * including the `post` ones, and applying those before the new image is live
   * is an outage on the image still serving — drizzle selects columns by name,
   * so a dropped column 500s every read the previous image performs.
   */
  it('refuses an unrecognised phase instead of falling back', () => {
    expect(() => readPhase(['--phase=pre-deploy'])).toThrow(/Unrecognised --phase/);
    expect(() => readPhase(['--phase='])).toThrow(/Unrecognised --phase/);
  });
});

describe('the dry-run switch', () => {
  it.each(['1', 'true', 'yes', 'TRUE', ' Yes '])('treats %j as a dry run', (value) => {
    expect(isDryRun({ DRY_RUN: value })).toBe(true);
  });

  it.each([undefined, '', 'false', 'no', '0'])('treats %j as an apply', (value) => {
    expect(isDryRun({ DRY_RUN: value })).toBe(false);
  });
});

describe('the migrations folder', () => {
  /**
   * Resolved from the package root rather than by counting directories, because
   * this module runs at two different depths — `src/db/` from source and
   * `dist/src/db/` once compiled. A wrong answer here does not throw: drizzle
   * reads an absent journal as "nothing pending", logs a success line and exits
   * 0, leaving the database empty while the deploy reports green.
   */
  it('points at a directory that really holds the journal', () => {
    expect(existsSync(MIGRATIONS_FOLDER)).toBe(true);

    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };

    // A floor, not a fixture: three migrations exist today and the point is that
    // a broken resolution cannot pass by finding an empty folder.
    expect(journal.entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of journal.entries) {
      expect(existsSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`))).toBe(true);
    }
  });

  it('resolves inside the backend package, not the repository root', () => {
    expect(MIGRATIONS_FOLDER).toContain(
      path.join('packages', 'backend', 'src', 'db', 'postgres', 'migrations'),
    );
  });

  /**
   * The offset from the migrator module to its migrations, which is what makes
   * the source tree and the compiled tree agree without either knowing about the
   * other: `rootDir` mirrors `src/db/` into `dist/src/db/`, so `postgres/
   * migrations` is correct in both.
   *
   * Asserted as the RELATIVE offset rather than as an absolute path, because the
   * absolute path is different in the two trees and only the offset is the
   * property. `deployWiring.test.ts` derives the `Dockerfile` destination from
   * this same constant.
   */
  it('sits at a fixed offset from the migrator module, in both trees', () => {
    const moduleDirectory = path.resolve(__dirname, '..', 'db');
    expect(path.relative(moduleDirectory, MIGRATIONS_FOLDER)).toBe(
      path.join('postgres', 'migrations'),
    );
  });
});
