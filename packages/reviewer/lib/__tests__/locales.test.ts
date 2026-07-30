/**
 * Locale parity.
 *
 * A missing key does not crash — i18next renders the key itself, so a reviewer
 * reading Spanish would see `review.step2.findings.severity` in the middle of a
 * form about violent material. That is the sort of failure nobody reports and
 * everybody works around, so it is checked here instead.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { FINDING_CONTEXTS, RECOMMENDED_ACTIONS, RELATION_TYPES, RESOURCE_TYPES, REVIEWER_ELIGIBILITY_REQUIREMENTS, REVIEWER_SENSITIVITY_CLASSES, REVIEWER_STATES, TAXONOMY_FAMILIES } from '@oxyhq/crowdsource-contracts';

import { REVIEWER_RECOMMENDED_ACTIONS } from '@/lib/review-form';
import en from '@/locales/en.json';
import esES from '@/locales/es.json';
import itIT from '@/locales/it.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : flatten(value, path);
  });
}

/** `{{name}}` placeholders a string interpolates. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
}

function valueAt(tree: Tree, path: string): string {
  const value = path.split('.').reduce<string | Tree | undefined>((node, key) => {
    return typeof node === 'object' && node !== null ? node[key] : undefined;
  }, tree);
  return typeof value === 'string' ? value : '';
}

const BASE = en as unknown as Tree;
const TRANSLATIONS: Record<string, Tree> = {
  'es-ES': esES as unknown as Tree,
  'it-IT': itIT as unknown as Tree,
};

describe('locales', () => {
  const baseKeys = flatten(BASE);

  it('has a non-trivial number of keys to compare', () => {
    // Vacuity floor: a flatten() that returned nothing would make every
    // comparison below pass without comparing anything.
    expect(baseKeys.length).toBeGreaterThan(200);
  });

  for (const [locale, tree] of Object.entries(TRANSLATIONS)) {
    it(`${locale} has exactly the keys en-US has`, () => {
      expect(flatten(tree).sort()).toEqual([...baseKeys].sort());
    });

    it(`${locale} interpolates the same placeholders as en-US`, () => {
      // A translation that drops `{{limit}}` silently renders a sentence with a
      // hole in it, which reads as a bug in the data rather than in the copy.
      const mismatches = baseKeys.filter(
        (key) =>
          placeholders(valueAt(BASE, key)).join(',') !==
          placeholders(valueAt(tree, key)).join(','),
      );
      expect(mismatches).toEqual([]);
    });
  }
});

/**
 * Every key a screen ASKS for must exist.
 *
 * Parity between the three files says nothing about whether any of them answers
 * the app: a key nobody translated and a key nobody uses look identical from
 * inside the locale data. i18next renders the key itself when it misses, so the
 * failure is a reviewer reading `review.step2.findings.severity` in the middle of
 * a form about violent material — the kind nobody reports and everybody works
 * around.
 *
 * This is the check whose absence let twenty-five dead keys and seventy missing
 * ones accumulate at once while the parity tests stayed green.
 */
describe('every key the app uses exists in en-US', () => {
  const PACKAGE_ROOT = join(__dirname, '..', '..');
  const SCANNED_DIRECTORIES = ['app', 'components', 'lib'];

  /** Every `.ts`/`.tsx` file under the scanned directories, tests excluded. */
  function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        return entry === '__tests__' ? [] : sources(path);
      }
      return /\.tsx?$/.test(entry) ? [path] : [];
    });
  }

  const files = SCANNED_DIRECTORIES.flatMap((directory) => sources(join(PACKAGE_ROOT, directory)));

  it('scanned a plausible number of files', () => {
    // Vacuity floor: a traversal that returned nothing would make the assertion
    // below pass by having no keys to check.
    expect(files.length).toBeGreaterThan(20);
  });

  /**
   * Literal `t('…')` keys only.
   *
   * A template key — `` t(`category.${family}`) `` — cannot be resolved by reading
   * the source, so those families are covered by the exhaustive blocks below
   * instead. Every literal is resolvable and is therefore checked.
   */
  const literalKeys = [
    ...new Set(
      files.flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)].map(
          (match) => match[1],
        ),
      ),
    ),
  ].sort();

  it('found the literal keys the screens use', () => {
    expect(literalKeys.length).toBeGreaterThan(100);
  });

  it('resolves every literal key', () => {
    const missing = literalKeys.filter((key) => valueAt(BASE, key) === '');
    expect(missing).toEqual([]);
  });

  /**
   * The template keys, one exhaustive block per vocabulary.
   *
   * These are the ones a source scan cannot see, and they are exactly the ones a
   * contract change breaks: a family, a state or a resource type added upstream
   * needs a label here, and without this it would render as its own identifier.
   */
  it.each([
    ['category', TAXONOMY_FAMILIES],
    ['reviewerState', REVIEWER_STATES],
    ['eligibility', REVIEWER_ELIGIBILITY_REQUIREMENTS],
    ['sensitivity', REVIEWER_SENSITIVITY_CLASSES],
    ['findingContext', FINDING_CONTEXTS],
    ['relation', RELATION_TYPES],
    ['review.resource.kind', RESOURCE_TYPES],
  ])('has a %s label for every value the contract defines', (prefix, values) => {
    expect(values.length).toBeGreaterThan(2);
    const missing = values.filter((value) => valueAt(BASE, `${prefix}.${value}`) === '');
    expect(missing).toEqual([]);
  });

  it('has an action label for every action a reviewer may recommend', () => {
    // The five-token subset, not all twenty-two: the rest belong to consensus and
    // the Trust & Safety console, and a juror never sees them.
    const offered = REVIEWER_RECOMMENDED_ACTIONS;
    expect(offered.length).toBeGreaterThan(2);
    expect(offered.every((action) => RECOMMENDED_ACTIONS.includes(action))).toBe(true);
    expect(offered.filter((action) => valueAt(BASE, `action.${action}`) === '')).toEqual([]);
  });
});
