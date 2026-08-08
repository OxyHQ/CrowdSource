import { mongooseBackend } from './harness.js';
import { postgresBackend } from './postgresHarness.js';
import type { ModerationBackend } from './backend.js';

/**
 * The backends the storage suites run against.
 *
 * In its own module rather than in `backend.ts`, and the reason is a real one
 * rather than taste: `backend.ts` holds `TEST_ACTIONS`, which the Postgres test
 * SCHEMA reads at module scope to build its enforcement CHECK. Listing the
 * harnesses there would make `backend.ts` import a module that imports
 * `backend.ts` back, and the cycle resolves as a temporal-dead-zone crash at
 * import time rather than as a warning.
 *
 * `CROWDSOURCE_APP_TEST_BACKEND` narrows the list to one entry; unset runs both.
 * An unrecognised value THROWS, and that is the important part: an empty
 * `describe.each` runs zero tests and vitest exits 0, so a typo would read as a
 * whole suite passing — and the mutation script would read it as every guard
 * holding.
 */
const ALL: readonly ModerationBackend[] = [mongooseBackend, postgresBackend];

function selected(): readonly ModerationBackend[] {
  const requested = process.env.CROWDSOURCE_APP_TEST_BACKEND;
  if (requested === undefined || requested === '') return ALL;

  const found = ALL.filter((backend) => backend.name === requested);
  if (found.length === 0) {
    throw new Error(
      `CROWDSOURCE_APP_TEST_BACKEND='${requested}' names no backend. Use one of: ` +
        `${ALL.map((backend) => backend.name).join(', ')} — or leave it unset to run both. ` +
        'Refusing to run zero backends, which vitest would report as a passing suite.',
    );
  }
  return found;
}

export const BACKENDS: readonly ModerationBackend[] = selected();
