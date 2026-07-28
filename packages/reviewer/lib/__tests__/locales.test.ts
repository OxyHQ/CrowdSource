/**
 * Locale parity.
 *
 * A missing key does not crash — i18next renders the key itself, so a reviewer
 * reading Spanish would see `review.step2.findings.severity` in the middle of a
 * form about violent material. That is the sort of failure nobody reports and
 * everybody works around, so it is checked here instead.
 */

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
