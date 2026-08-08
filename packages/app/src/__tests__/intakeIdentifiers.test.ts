/**
 * Invariant: a whitespace-only identifier is refused at intake.
 *
 * `'   '` is not an identifier. It arrives from a form field, from a value
 * trimmed somewhere else, or from a client that sends `' '` for absent — and
 * stored, it is an id that matches nothing and reads as present. The duplicate
 * check finds no earlier report, the delivery carries it as
 * `externalReportId`, and nothing fails until a human asks why a case names
 * nobody.
 *
 * ## Why these fixtures and not the obvious ones
 *
 * This guard was `value.length === 0` until Syra's adoption found it, and it
 * survived because every fixture in this package sat on the SAME SIDE of the
 * distinction the check exists to make: real ids, `''`, and non-strings. All
 * three behave identically under `length === 0` and under `trim() === ''`, so
 * no test could tell the two implementations apart.
 *
 * The shapes below are chosen to make them disagree — a space, a tab, a
 * newline, and a non-breaking space. Each is refused by the strict version and
 * ACCEPTED by the loose one, which is what makes this file evidence rather than
 * decoration. The empty string and the non-strings are kept alongside them so a
 * guard deleted outright still fails here too.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './support/backend.js';
import { BACKENDS } from './support/backends.js';

/**
 * Both backends, one suite. The leaf test names are unchanged: vitest prints
 * `mongoose > <name>` and `postgres > <name>`, and the mutation script matches on
 * the leaf.
 */
describe.each(BACKENDS)('$name', (backend) => {

  let harness: Harness | null = null;

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  describe('intake refuses an identifier that only looks like one', () => {
    /**
     * Each of these is non-empty by `length`, so `length === 0` lets every one
     * through. Named individually so a failure says WHICH shape got in.
     */
    const BLANK: readonly { readonly label: string; readonly value: string }[] = [
      { label: 'a space', value: ' ' },
      { label: 'several spaces', value: '   ' },
      { label: 'a tab', value: '\t' },
      { label: 'a newline', value: '\n' },
      { label: 'a non-breaking space', value: ' ' },
    ];

    it('refuses a blank reporter', async () => {
      harness = await backend.createHarness();
      const widgetId = await harness.app.createWidget({ body: 'hello', ownerId: 'oxy-owner' });

      for (const blank of BLANK) {
        await expect(
          harness.moderation.createReport({
            reporter: blank.value,
            reportedType: 'widget',
            reportedId: widgetId,
            categories: ['spam'],
          }),
          `a reporter that is ${blank.label} must be refused`,
        ).rejects.toThrow(TypeError);
      }

      // Nothing was stored by any of them — the guard runs before the
      // transaction, so a refusal that still wrote a row would be a different
      // defect wearing the same error.
      expect(await harness.app.countReports()).toBe(0);
    });

    it('refuses a blank reportedId', async () => {
      harness = await backend.createHarness();

      for (const blank of BLANK) {
        await expect(
          harness.moderation.createReport({
            reporter: 'oxy-reporter',
            reportedType: 'widget',
            reportedId: blank.value,
            categories: ['spam'],
          }),
          `a reportedId that is ${blank.label} must be refused`,
        ).rejects.toThrow(TypeError);
      }

      expect(await harness.app.countReports()).toBe(0);
    });

    /**
     * The floor: a real identifier still gets through. Without it, a guard that
     * refused EVERYTHING would satisfy every assertion above.
     */
    it('still accepts an ordinary identifier', async () => {
      harness = await backend.createHarness();
      const widgetId = await harness.app.createWidget({ body: 'hello', ownerId: 'oxy-owner' });

      const { report } = await harness.moderation.createReport({
        reporter: 'oxy-reporter',
        reportedType: 'widget',
        reportedId: widgetId,
        categories: ['spam'],
      });

      expect(report.reporter).toBe('oxy-reporter');
      expect(await harness.app.countReports()).toBe(1);
    });
  });
});
