#!/usr/bin/env bun

/**
 * No published package ships a migrations folder.
 *
 * ## Why this is a check and not a convention
 *
 * `@oxyhq/db`'s migration ledger applies a migration only when its journal
 * timestamp is strictly newer than the newest one already recorded. Two journals
 * against one `drizzle.__drizzle_migrations` table therefore interleave, and the
 * loser is **skipped in silence, with exit 0**. A library that ships its own
 * migrations does not conflict with an adopter's — it makes one of them
 * disappear, on a schedule nobody controls, with no error anywhere.
 *
 * So `@oxyhq/crowdsource-app` ships table DEFINITIONS and the adopter's own
 * `drizzle-kit generate` produces the SQL, in the adopter's own journal. The
 * package's own migrations exist only under `src/__tests__/`, which `files`
 * excludes.
 *
 * That arrangement is one helpful edit away from being undone: moving the folder
 * somewhere "tidier" breaks nothing locally, passes every test, and ships. The
 * design document names it as the recommendation most likely to be reversed by
 * someone trying to help, which is exactly the shape that needs a gate rather
 * than a paragraph.
 *
 * ## What it reads
 *
 * The PACKED file list — `bun pm pack --dry-run`, the same resolution of `files`
 * that a publish performs — rather than the source tree. A path can be excluded
 * from the tarball and still exist on disk, and it is the tarball that reaches an
 * adopter.
 *
 * Run against a different tree with `bun scripts/check-published-migrations.mjs <root>`,
 * which is how `test-check-published-migrations.mjs` mutation-tests it.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The packages whose tarball an adopter installs. */
const PUBLISHED = ["contracts", "sdk", "sdk-express", "testing", "app"];

/** Any path segment naming a migration. Case-insensitive: `Migrations/` ships too. */
const MIGRATION = /(^|\/)migrations?(\/|$)|\.sql$/i;

const repositoryRoot =
  process.argv[2] === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
    : resolve(process.argv[2]);

const failures = [];
let packagesChecked = 0;

for (const name of PUBLISHED) {
  const packageDir = resolve(repositoryRoot, "packages", name);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
  } catch {
    failures.push(`packages/${name}/package.json is missing or unreadable.`);
    continue;
  }

  const packed = Bun.spawnSync({
    cmd: ["bun", "pm", "pack", "--dry-run"],
    cwd: packageDir,
  });
  const output = `${new TextDecoder().decode(packed.stdout)}${new TextDecoder().decode(packed.stderr)}`;
  if (packed.exitCode !== 0) {
    failures.push(`packages/${name} could not be packed:\n${output}`);
    continue;
  }

  /** `packed <size> <path>` per line; anything else is a banner. */
  const files = output
    .split("\n")
    .map((line) => /^packed\s+\S+\s+(.+)$/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => match[1]);

  /**
   * More than the manifest alone. `package.json` is packed unconditionally, so a
   * `files` array matching NOTHING still yields one entry — and a check that then
   * reported "no migrations" would be telling the truth about an empty tarball.
   * Measured: a fixture whose `files` array names a directory that does not exist
   * packs exactly one file and passed the naive `length === 0` floor.
   *
   * (The glob is described rather than written, because a recursive glob inside a
   * block comment closes the comment early — its separator IS the terminator. That
   * trap cost a bisect in `drizzle.config.ts`, where nothing type-checked the file;
   * here the mutation test caught it in one run.)
   */
  const shipped = files.filter((file) => file !== "package.json");
  if (shipped.length === 0) {
    failures.push(
      `packages/${name} packed nothing but its manifest, so this check examined ` +
        "nothing. That is a broken `files` array or a changed pack output format, " +
        "not a clean package.",
    );
    continue;
  }
  packagesChecked += 1;

  const offenders = shipped.filter((file) => MIGRATION.test(file));
  if (offenders.length > 0) {
    failures.push(
      `${manifest.name ?? `packages/${name}`} ships ${offenders.length} migration file(s): ` +
        `${offenders.slice(0, 5).join(", ")}${offenders.length > 5 ? ", …" : ""}. ` +
        "A library's migrations interleave with the adopter's in one ledger table, and " +
        "the loser is skipped silently with exit 0 — keep them under src/__tests__/, " +
        "which `files` excludes.",
    );
  }
}

/** A traversal that packed nothing must not pass. */
if (packagesChecked < PUBLISHED.length) {
  failures.push(
    `only ${packagesChecked} of ${PUBLISHED.length} published packages were packed; ` +
      "the rest failed before their file list could be read.",
  );
}

if (failures.length > 0) {
  console.error("The published-migrations check failed:\n");
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}

console.log(
  `None of the ${packagesChecked} published package(s) ship a migration file.`,
);
