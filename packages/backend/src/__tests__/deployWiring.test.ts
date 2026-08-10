import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER } from '../db/migrate';

/**
 * The joins between this package and the deploy that nothing else can fail on.
 *
 * Every claim here spans two files that must agree and that no compiler,
 * linter or runtime ever compares: a `tsc` emit path against a shell command, a
 * `.sql` directory against a `COPY`, a workflow's concurrency block against a
 * migrator that documents its absence of a lock. Each disagreement produces a
 * green build, a pushed image, and a failure that first appears mid-deploy —
 * two of them silently.
 *
 * They are asserted DERIVED rather than restated. A test that hardcodes the same
 * path the workflow hardcodes agrees with it by construction and would pass
 * through exactly the rename it exists to catch.
 */

const packageRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

function read(...segments: string[]): string {
  return readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

const deployScript = read('.github', 'scripts', 'deploy-ecs-image.sh');
const deployWorkflow = read('.github', 'workflows', 'deploy-aws.yml');
const dockerfile = readFileSync(path.join(packageRoot, 'Dockerfile'), 'utf8');
const tsconfig = readFileSync(path.join(packageRoot, 'tsconfig.json'), 'utf8');

describe('the migration entrypoint the deploy runs', () => {
  /**
   * The deploy names a compiled path; `tsconfig` decides where `tsc` puts it.
   *
   * `rootDir: "./"` and `outDir: "dist"` mean `scripts/migrate.ts` emits to
   * `dist/scripts/migrate.js`. Move the source file, change either option, or
   * drop `scripts/**` from `include`, and the image still builds and still
   * pushes — the failure is the migration task exiting non-zero with "module not
   * found", after production has the image.
   */
  it('is emitted where the deploy names it', () => {
    expect(tsconfig).toMatch(/"rootDir":\s*"\.\/"/);
    expect(tsconfig).toMatch(/"outDir":\s*"dist"/);
    expect(tsconfig).toMatch(/"include":\s*\[[^\]]*"scripts\/\*\*\/\*\.ts"/s);

    /**
     * Derived from those three, not restated from the deploy.
     *
     * Searched across BOTH files because the command moved: it used to be
     * hardcoded in `deploy-ecs-image.sh`, and is now `MIGRATION_COMMAND_JSON`
     * in the workflow, so the script can serve any consumer's entrypoint and
     * the phases can be appended per run. Today the workflow carries it in the
     * comment that says what to set when `RUN_MIGRATIONS` is flipped; after the
     * flip it carries it as the value. Either satisfies this, and a rename of
     * `scripts/migrate.ts` that forgets the deploy satisfies neither.
     */
    const emitted = path.posix.join('packages/backend', 'dist', 'scripts', 'migrate.js');
    expect(`${deployScript}\n${deployWorkflow}`).toContain(emitted);
  });

  /**
   * `tsc` copies no `.sql` file. Without this COPY the image holds a migration
   * entrypoint and nothing to apply — and drizzle reads a folder with no journal
   * as "nothing pending", so the one-shot logs a success line and exits 0 while
   * the database stays empty. That is the failure this whole cutover is shaped
   * around: a broken step that reports success.
   */
  /**
   * Anchored to the start of a LINE, and deliberately not `dotAll`.
   *
   * The first version of this assertion was `/COPY --from=builder .*<path>/s`,
   * which spans newlines — so it would have been satisfied by an earlier
   * `COPY --from=builder` line plus the path appearing anywhere later, including
   * inside the comment explaining why the COPY exists. It killed its mutation
   * only because that comment happens not to spell the path with a trailing
   * slash, which is luck rather than a property.
   */
  it('ships the SQL migrations it is supposed to apply', () => {
    expect(dockerfile).toMatch(
      /^COPY --from=builder \/app\/packages\/backend\/src\/db\/postgres\/migrations\//m,
    );
  });

  /**
   * The destination is DERIVED from `MIGRATIONS_FOLDER` itself, so the image
   * cannot ship the files anywhere but where the migrator looks.
   *
   * This is the assertion that would have caught the second of the two defects
   * this file exists for. `src/db/migrate.ts` resolves the folder relative to
   * its own directory, and `rootDir` mirrors the source tree into `dist/` — so
   * the compiled migrator looks under `dist/src/db/postgres/migrations`, not
   * under `src/`. An earlier version resolved the folder by walking up to the
   * nearest `package.json`, which looked depth-independent and is not: `tsc`
   * emits `dist/package.json` (it is named in `include`), so the walk stopped at
   * `dist` and the two halves disagreed. Both were only visible by running the
   * built entrypoint; `tsc` and every unit test were clean.
   */
  it('copies them where the compiled migrator will look for them', () => {
    const relative = path.relative(packageRoot, MIGRATIONS_FOLDER);
    const destination = path.posix.join(
      'packages/backend',
      'dist',
      relative.split(path.sep).join('/'),
      '/',
    );

    expect(destination).toBe('packages/backend/dist/src/db/postgres/migrations/');
    expect(dockerfile).toContain(destination);
  });
});

/**
 * Every module `scripts/migrate.ts` pulls in, following relative imports only.
 *
 * Package imports are not followed on purpose: the question is what of THIS
 * SERVICE the entrypoint drags in, and `pino` or `@oxyhq/db` reaching for
 * something of ours is not a shape this repository has.
 */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    const source = readFileSync(current, 'utf8');
    for (const match of source.matchAll(/(?:from|require\()\s*['"](\.[^'"]+)['"]/g)) {
      const resolved = path.resolve(path.dirname(current), match[1]);
      for (const candidate of [`${resolved}.ts`, path.join(resolved, 'index.ts')]) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return seen;
}

describe('migrationEntrypointIsolation', () => {
  const entrypoint = path.join(packageRoot, 'scripts', 'migrate.ts');
  const reachable = reachableFrom(entrypoint);

  /**
   * A vacuity floor. A traversal that resolved nothing would return just the
   * entrypoint and pass the assertion below by measuring nothing — the same
   * shape as every broken census. The runner and its own modules are reachable
   * by construction, so a count below this means the walk is broken.
   */
  it('actually walks the import graph', () => {
    expect(reachable.size).toBeGreaterThanOrEqual(2);
    expect(reachable).toContain(path.join(packageRoot, 'src', 'db', 'migrate.ts'));
  });

  /**
   * The defect this exists for, found by running the BUILT entrypoint rather
   * than by reading it.
   *
   * `src/config` requires `DATABASE_URL` — the APPLICATION role's credential —
   * and the migration one-shot must run holding only the migrator's. The first
   * version of `scripts/migrate.ts` imported `src/utils/logger`, which imports
   * `config`, so the compiled entrypoint died at module load with
   * `Invalid environment configuration — DATABASE_URL` before reading a single
   * migration. `tsc` was clean, every unit test was green, and the failure would
   * have appeared in the deploy's migration task after the image was pushed.
   *
   * Two levels of indirection were enough to hide it, which is why this is a
   * graph walk rather than a check on the entrypoint's own import list.
   */
  it('never reaches the application configuration', () => {
    const configModule = path.join(packageRoot, 'src', 'config', 'index.ts');
    expect(existsSync(configModule)).toBe(true);
    expect([...reachable]).not.toContain(configModule);
  });
});

describe('the migration interlock', () => {
  /**
   * `@oxyhq/db`'s runner states in its own header that it takes NO lock against
   * a second concurrent migrator — drizzle reads the ledger's high-water mark
   * outside its transaction, so two runs read the same mark and both attempt the
   * same DDL — and assigns the interlock to the caller, naming this exact case:
   * a deploy's own migration step racing a manually dispatched one.
   *
   * The workflow-level `concurrency` group is that interlock. It already exists,
   * so this pins it rather than adding it.
   */
  it('serialises deploys at the workflow level', () => {
    expect(deployWorkflow).toMatch(/^concurrency:/m);
    expect(deployWorkflow).toMatch(/group:\s*deploy-crowdsource-backend/);
  });

  /**
   * `cancel-in-progress: false` reads like a missed optimisation and is the
   * opposite. Cancelling between `run-task` and its exit-code check orphans a
   * live migration task and reports nothing; and in this workflow family
   * cancellation does not PREVENT the defensive rollback, it triggers one.
   */
  it('never cancels a deploy that is already running', () => {
    expect(deployWorkflow).toMatch(/cancel-in-progress:\s*false/);
    expect(deployWorkflow).not.toMatch(/cancel-in-progress:\s*true/);
  });
});

describe('the secrets the service cannot boot without', () => {
  /**
   * SYNCED IMPLIES NAMED — an implication, not a biconditional, and the
   * correction matters more than the rule.
   *
   * This started as `inAllowlist === inTaskDefinition`, on the reasoning that a
   * sync entry and a task-definition entry are two halves of one fact. That is
   * true only while CI OWNS the secret. `/oxy/crowdsource/DATABASE_URL` is a
   * hand-written SecureString with no GitHub secret behind it, so the
   * biconditional would have failed the correct configuration and, worse, the
   * obvious way to satisfy it would be to add the allow-list entry — which
   * declares CI ownership of a value CI does not write, and arms the next
   * deploy to overwrite a live credential with an empty or placeholder secret.
   *
   * What the workflow can genuinely enforce is one direction: a secret CI
   * writes that no task definition names reaches SSM and nothing else, which is
   * what the file's own comment says. The converse — named but not synced — is
   * legitimate and is the intended configuration for every hand-managed
   * parameter.
   *
   * What this cannot check is that the named parameter EXISTS in SSM. That is
   * an infrastructure fact, and naming one that does not exist is what holds a
   * service at `desired_count = 0`, unable to start.
   */
  it('never syncs a secret the task definition does not name', () => {
    const syncedNames = /SSM_SECRET_ALLOWLIST:([^\n]*)/.exec(deployWorkflow)?.[1] ?? '';
    const taskDefinition =
      /TASK_SECRET_OVERRIDES_JSON:[\s\S]*?\n(?= {8}\S|\S)/.exec(deployWorkflow)?.[0] ?? '';

    const synced = syncedNames.trim().split(/\s+/).filter(Boolean);
    expect(synced.length).toBeGreaterThan(0); // the allow-list must not read as empty

    for (const name of synced) {
      expect(taskDefinition).toContain(`"${name}"`);
    }
  });

  /**
   * The named-but-unsynced direction, asserted as a POSITIVE fact rather than
   * left implicit, so that reintroducing the allow-list entry is a deliberate
   * act somebody has to argue for rather than a tidy-up nobody notices.
   */
  it('leaves the hand-managed DATABASE_URL out of the sync allow-list', () => {
    expect(deployWorkflow).toMatch(
      /TASK_SECRET_OVERRIDES_JSON:[\s\S]*?"DATABASE_URL":[\s\S]*?parameter\/oxy\/crowdsource\/DATABASE_URL/,
    );
    expect(deployWorkflow).not.toMatch(/SSM_SECRET_ALLOWLIST:[^\n]*\bDATABASE_URL\b/);
  });

  /**
   * The migrator's credential must NOT be on the serving task definition.
   *
   * `crowdsource_migrator` owns every table, and a table's owner is exempt from
   * its own row-security policies and can `DROP POLICY` in one statement. The
   * entire isolation guarantee rests on the serving container holding only
   * `crowdsource_app`, which owns nothing. Putting the migrator's URL in
   * `TASK_SECRET_OVERRIDES_JSON` would hand every request path a credential that
   * can switch the tenant boundary off, and nothing would look different.
   */
  it('keeps the migrator credential off the serving container', () => {
    const overrides = /TASK_SECRET_OVERRIDES_JSON:([\s\S]*?)\n {8}\w/.exec(deployWorkflow);
    expect(overrides).not.toBeNull();
    expect(overrides?.[1]).not.toContain('MIGRATOR_DATABASE_URL');
  });
});
