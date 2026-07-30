/**
 * Locale parity.
 *
 * A missing key does not crash — i18next renders the key itself, so an operator
 * reading Spanish would see `webhooks.rotated.signingStartsAtHint` in the middle of a
 * secret rotation. That is the sort of failure nobody reports and everybody works
 * around, so it is checked here instead.
 *
 * The placeholder check matters as much as the key check: a translation that drops
 * `{{origin}}` or `{{limit}}` renders a sentence with a hole in it, which reads as a
 * bug in the data rather than in the copy.
 */

import en from '@/locales/en.json';
import esES from '@/locales/es.json';

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
};

describe('locales', () => {
  const baseKeys = flatten(BASE);

  it('has a non-trivial number of keys to compare', () => {
    // Vacuity floor: a flatten() that returned nothing would make every comparison
    // below pass without comparing anything.
    expect(baseKeys.length).toBeGreaterThan(200);
  });

  for (const [locale, tree] of Object.entries(TRANSLATIONS)) {
    it(`${locale} has exactly the keys en-US has`, () => {
      expect(flatten(tree).sort()).toEqual([...baseKeys].sort());
    });

    it(`${locale} interpolates the same placeholders as en-US`, () => {
      const mismatches = baseKeys.filter(
        (key) =>
          placeholders(valueAt(BASE, key)).join(',') !==
          placeholders(valueAt(tree, key)).join(','),
      );
      expect(mismatches).toEqual([]);
    });
  }

  it('never renders an absent value as a zero', () => {
    // `common.absent` is the one string the whole app uses for "no measurement
    // exists", and it must not be a digit in any locale: `evidenceIntegrity` is null
    // because nothing measures it, and a `0` there reports the worst possible score.
    for (const tree of [BASE, ...Object.values(TRANSLATIONS)]) {
      expect(valueAt(tree, 'common.absent')).toBe('—');
    }
  });

  it('never presents `inconclusive` as the same thing as `no_violation`', () => {
    // The labels are the other half of the invariant `presentation.test.ts` asserts
    // for the colour. Two outcomes that mean different things must not read the same
    // in any locale.
    for (const tree of [BASE, ...Object.values(TRANSLATIONS)]) {
      const inconclusive = valueAt(tree, 'outcome.inconclusive');
      const noViolation = valueAt(tree, 'outcome.no_violation');
      expect(inconclusive).not.toBe('');
      expect(noViolation).not.toBe('');
      expect(inconclusive).not.toBe(noViolation);
    }
  });
});
