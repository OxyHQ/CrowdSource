/**
 * The chrome pins at the gutter Bloom actually draws, and nothing redeclares it.
 *
 * NativeWind needs a class present as a literal string at build time, so
 * `STICKY_TOP_CLASS` spells the two offsets out rather than interpolating them. That is a
 * duplication of `PANEL_TOP_INSET`, and the failure it invites is silent: Bloom changes
 * its gutter, the chrome pins 8px away from the edge the panel now has, and nothing fails
 * anywhere.
 *
 * There is deliberately no second sticky level to check. `PanelChrome` has ONE, and
 * `Screen` puts the header row and the toolbar inside it, so the stacked-offset
 * arithmetic that would need a test does not exist — see that module's comment for why
 * measuring the header would have been the alternative.
 *
 * ## Why this reads source text instead of importing the module
 *
 * `PanelChrome.tsx` imports `PANEL_TOP_INSET` from `@oxyhq/bloom/content-panel`, and the
 * `react-native` export condition resolves that to Bloom's published `src/` — ESM that
 * jest-expo's `transformIgnorePatterns` does not transform, because `@oxyhq` is not on
 * its allowlist. Importing the component here would fail on a syntax error in a
 * dependency rather than on anything about this app.
 *
 * Reading the text is not a workaround, though: it lets the check ALSO assert that the
 * inset is imported from Bloom rather than redeclared, which is the property that keeps
 * this app's chrome aligned with the published panel. Bloom's own declaration is read
 * from the same file Metro compiles, so a change to the published value fails here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PANEL_CHROME = readFileSync(join(__dirname, '..', 'shell', 'PanelChrome.tsx'), 'utf8');

/** Bloom's own gutter inset, from the source the `react-native` condition selects. */
const BLOOM_CONTENT_PANEL = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'node_modules',
    '@oxyhq',
    'bloom',
    'src',
    'content-panel',
    'index.tsx',
  ),
  'utf8',
);

function declaredNumber(source: string, name: string): number {
  const match = new RegExp(`(?:export )?const ${name} = (\\d+);`).exec(source);
  if (match === null) {
    throw new Error(`No 'const ${name} = <number>;' declaration found`);
  }
  return Number(match[1]);
}

function declaredClass(state: 'framed' | 'bleed'): string {
  const table = /STICKY_TOP_CLASS[^=]*= \{([\s\S]*?)\n\};/.exec(PANEL_CHROME);
  if (table === null) {
    throw new Error('No STICKY_TOP_CLASS table found in PanelChrome.tsx');
  }
  const row = new RegExp(`${state}: '([^']+)'`).exec(table[1]);
  if (row === null) {
    throw new Error(`No '${state}' entry in STICKY_TOP_CLASS`);
  }
  return row[1];
}

describe('the sticky chrome inset', () => {
  const gutter = declaredNumber(BLOOM_CONTENT_PANEL, 'PANEL_TOP_INSET');

  it('read both sources', () => {
    // Vacuity floor: a regex that matched nothing throws above, but a file that read as
    // empty would make the comparisons meaningless.
    expect(PANEL_CHROME.length).toBeGreaterThan(500);
    expect(gutter).toBeGreaterThan(0);
  });

  it('imports the gutter inset from Bloom rather than redeclaring it', () => {
    // The published panel draws the gutter; a local copy of the number is how the chrome
    // ends up pinned 8px away from the edge the panel actually has.
    expect(PANEL_CHROME).toMatch(
      /import \{ PANEL_TOP_INSET \} from '@oxyhq\/bloom\/content-panel';/,
    );
    expect(PANEL_CHROME).not.toMatch(/const PANEL_TOP_INSET =/);
  });

  it('pins framed chrome at exactly that gutter', () => {
    // Tailwind's spacing scale is 0.25rem per step, so `web:top-2` is 8px.
    expect(declaredClass('framed')).toBe(`web:top-${gutter / 4}`);
  });

  it('drops the gutter when the panel is full-bleed', () => {
    // Below the panel's breakpoint there is no gutter, and chrome offset by 8px would
    // leave a stray band of background above it.
    expect(declaredClass('bleed')).toBe('web:top-0');
  });

  it('has exactly one sticky level', () => {
    // The absence is the design: a second level would need to know how tall the row
    // above it is, and a header with a subtitle is taller than any constant.
    expect(PANEL_CHROME).not.toMatch(/ChromeLevel|level\?:|level =/);
  });
});
