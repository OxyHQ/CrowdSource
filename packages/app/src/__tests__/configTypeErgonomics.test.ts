/**
 * The config shapes a real consumer writes must compile without annotations
 * they cannot know they need.
 *
 * This file is mostly for `tsc`, which is the point: `bun run lint` type-checks
 * it, so a regression is a build failure rather than an adopter's afternoon.
 *
 * The defect it pins was found the only way it could be — by `mention-finish`
 * collapsing Mention onto the package with its real enforcement table. Left to
 * inference, TypeScript unions the effect branches into
 * `{ status: string; metadataIsSensitive?: undefined }`, which is not a
 * `Record` of scalars, so the whole `apply` fails to assign. **Every consumer
 * with more than two effects hits it**, and the error names the entire function
 * rather than the offending branch, so there is no signal about which return is
 * the problem.
 *
 * A required annotation nobody can infer the need for is a defect that presents
 * as the consumer's mistake.
 */

import mongoose, { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  ModerationRestoreDirectionError,
  assertRestoreDirection,
  planEnforcement,
} from '../enforcement/planner.js';
import { createModerationIntegration } from '../integration.js';
import { moderationReportSchemaFields } from '../mongoose/report.js';
import { mongooseModerationStore } from '../mongoose/store/index.js';
import { decision } from './support/decisions.js';
import type {
  ModerationEnforcementConfig,
  ModerationReportFields,
} from '../types.js';

type CommerceAction = 'delist' | 'relist' | 'flag' | 'unflag' | 'review' | 'none';

/**
 * Deliberately NOT annotated: `apply` has no return type, and its branches
 * return different `previousState` keys. This is how an adopter writes it, and
 * it is the exact shape that used to fail to compile.
 */
const commerce: ModerationEnforcementConfig<CommerceAction> = {
  actions: ['delist', 'relist', 'flag', 'unflag', 'review', 'none'],
  noneAction: 'none',
  reviewAction: 'review',
  /**
   * The actions that DO the undoing. `['delist', 'flag']` here would plan a
   * removal on an accepted appeal — it type-checks and applies the punishment
   * it was correcting.
   */
  restoreAction: ['relist', 'unflag'],
  recommendationToAction: { remove: 'delist', label: 'flag', restore: 'relist' },
  absorb: { delist: ['flag', 'none'] },
  precedence: ['delist', 'relist', 'flag', 'unflag', 'review', 'none'],
  reversibleActions: ['relist', 'unflag'],
  reverses: { relist: ['delist'], unflag: ['flag'] },
  async apply({ action }) {
    if (action === 'delist') return { changed: true, previousState: { status: 'published' } };
    if (action === 'flag') return { changed: true, previousState: { isSensitive: false } };
    if (action === 'relist') return { changed: true, previousState: { status: 'delisted' } };
    if (action === 'unflag') return { changed: true, previousState: { isSensitive: true } };
    return { changed: false, reason: `no '${action}' effect`, recordedAs: 'none' };
  },
};

/** The other end of the range: an application that cannot enforce at all. */
const reviewOnly: ModerationEnforcementConfig<'none' | 'review'> = {
  actions: ['review', 'none'],
  noneAction: 'none',
  reviewAction: 'review',
  restoreAction: null,
};

describe('an adopter config compiles as written', () => {
  it('accepts four effect branches with different previousState keys', () => {
    // The assertion `tsc` already made; this one keeps the file executable and
    // proves the config is a working one rather than merely well-typed.
    expect(typeof commerce.apply).toBe('function');
    const plan = planEnforcement(
      decision({ outcome: 'no_violation', findings: [], recommendedActions: [] }),
      commerce,
    );
    expect(plan.map((entry) => entry.action).sort()).toEqual(['relist', 'unflag']);
  });

  it('accepts a three-field config with no apply and no tables', () => {
    expect(reviewOnly.apply).toBeUndefined();
    const plan = planEnforcement(
      decision({ outcome: 'no_violation', findings: [], recommendedActions: [] }),
      reviewOnly,
    );
    expect(plan.map((entry) => entry.action)).toEqual(['none']);
  });
});

describe('an inverted restoreAction is refused at construction', () => {
  /**
   * The one configuration error in this package that cannot be caught by a type
   * and does not fail at runtime. Both directions are `TAction[]`, so `tsc` is
   * silent; and the inverted value plans, claims and APPLIES — a restriction and
   * a label on an accepted appeal, the correction carrying out the punishment it
   * was correcting.
   *
   * It has been written wrong twice in one hour, by the author of the field.
   * That is the evidence that a doc line is not sufficient.
   */
  const base: ModerationEnforcementConfig<CommerceAction> = {
    ...commerce,
    reverses: { relist: ['delist'], unflag: ['flag'] },
  };

  it('throws when restoreAction names the actions being undone', () => {
    expect(() =>
      assertRestoreDirection({ ...base, restoreAction: ['delist', 'flag'] }),
    ).toThrow(ModerationRestoreDirectionError);
  });

  it('names the offending actions and the direction, not just "invalid"', () => {
    try {
      assertRestoreDirection({ ...base, restoreAction: ['delist', 'flag'] });
      expect.unreachable('the inverted config should have been refused');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('delist');
      expect(message).toContain('flag');
      expect(message).toContain('UNDONE');
      expect(message).toContain('accepted appeal');
    }
  });

  it('accepts the correct direction', () => {
    expect(() =>
      assertRestoreDirection({ ...base, restoreAction: ['relist', 'unflag'] }),
    ).not.toThrow();
  });

  /**
   * The two shapes that must NOT trip it, or a correct configuration gets
   * refused and the guard is worse than nothing.
   */
  it('accepts a restore action that reverses nothing', () => {
    expect(() =>
      assertRestoreDirection({ ...base, restoreAction: ['relist', 'review'] }),
    ).not.toThrow();
  });

  it('accepts an action that both undoes and is undone', () => {
    expect(() =>
      assertRestoreDirection({
        ...base,
        reverses: { relist: ['delist'], delist: ['relist'] },
        restoreAction: ['relist', 'delist'],
      }),
    ).not.toThrow();
  });

  it('accepts null and an empty reverses map', () => {
    expect(() => assertRestoreDirection({ ...commerce, restoreAction: null })).not.toThrow();
    expect(() =>
      assertRestoreDirection({ ...commerce, reverses: {}, restoreAction: ['relist'] }),
    ).not.toThrow();
  });
});

/**
 * The wiring example in `src/index.ts` and `README.md`, as code the compiler
 * reads.
 *
 * A documented example is the one piece of a package nothing executes, so it
 * survives a signature change indefinitely — and this one changed twice in a
 * week. Written here, the example is compiled by `bun run lint` and constructed
 * by the run below, so a config field that moves breaks a build rather than an
 * adopter's afternoon.
 *
 * The three type parameters are the point of the assertion: `createModerationIntegration`
 * is called with NONE of them written down. `TReport` and `TTx` come from the
 * store, `TAction` from the enforcement table, and TypeScript has no partial
 * explicit type arguments — so a caller who has to name one has to name all
 * three, including a transaction type they should never have to think about.
 */
type CommerceReport = ModerationReportFields;

describe('the documented wiring', () => {
  it('compiles and constructs with no type arguments and no annotations', async () => {
    // Never connected: this constructs the integration and does no I/O, which is
    // the whole surface being asserted.
    const connection = mongoose.createConnection();
    const reportModel = connection.model<CommerceReport>(
      'DocumentedReport',
      new Schema<CommerceReport>({ ...moderationReportSchemaFields() }, { timestamps: true }),
    );

    const store = mongooseModerationStore({
      connection,
      reportModel,
      enforcementActions: commerce.actions,
    });

    const moderation = createModerationIntegration({
      store,
      crowdSource: { enabled: true, enforcementMode: 'observe' },
      subjects: [],
      taxonomy: { version: '2026.07', allegationsFor: () => ['other.unclassifiable'] },
      enforcement: commerce,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    expect(typeof moderation.createReport).toBe('function');
    expect(moderation.deliverableTypes()).toEqual([]);
    // `ensureSchema()` is the one call in the example that needs a server, so it
    // is documented rather than run here.
    expect(typeof store.ensureSchema).toBe('function');

    await connection.close();
  });
});
