import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * "A published decision is never edited, only superseded" (§9.9, Appendix F) —
 * as a checked property of the source tree rather than as a rule somebody
 * remembers.
 *
 * §9.9 is precise about what is immutable and what is not: "nunca se sobreescribe
 * outcome, findings o policyVersion de una decisión publicada". `status` is NOT
 * on that list and its own worked example requires it to move — revision 1
 * becomes `superseded` when revision 2 lands. So the rule this file enforces is
 * not "nothing about a decision changes", it is:
 *
 *   1. exactly one module may write to an already-published decision at all, and
 *   2. the one write it performs sets `status` and nothing else.
 *
 * A behavioural test can only show that today's code does not rewrite an
 * outcome. This is what fails when somebody adds the function that would.
 *
 * The defences the ecosystem's own lesson asks for are both here: a mutation
 * test that breaks the thing being guarded and confirms the check fails AND
 * names the offender, and a vacuity floor so a broken traversal cannot pass
 * silently.
 */

const backendRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(backendRoot, 'src');

interface SourceFile {
  readonly path: string;
  readonly source: string;
}

function collectSources(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : collectSources(absolute);
    }
    if (!entry.name.endsWith('.ts')) return [];
    return [
      {
        path: path.relative(backendRoot, absolute).replaceAll(path.sep, '/'),
        source: readFileSync(absolute, 'utf8'),
      },
    ];
  });
}

const sources = collectSources(sourceRoot);

/**
 * The one module allowed to write to a published decision.
 *
 * `decision.collection.ts` DECLARES the collection, so it does not call it.
 * `decision.service.ts` owns the single sanctioned write — `markSuperseded` —
 * and adding a second module to this list has to be a deliberate edit here.
 */
const DECISION_WRITERS: readonly string[] = ['src/modules/decision/decision.service.ts'];

/** Any mutating call against the `decisions` collection. */
const DECISION_MUTATION = /\bdecisions\s*\.\s*(updateOne|findOneAndUpdate|upsertOne|insertOne)\s*\(/;

function decisionWriters(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => DECISION_MUTATION.test(file.source))
    .map((file) => file.path)
    .sort();
}

describe('only one module writes to a decision', () => {
  it('scanned the source tree', () => {
    // The vacuity floor: a traversal that returned nothing would make every
    // assertion below pass while checking no files at all.
    expect(sources.length).toBeGreaterThanOrEqual(40);
    const paths = sources.map((file) => file.path);
    expect(paths).toContain('src/modules/decision/decision.service.ts');
    expect(paths).toContain('src/modules/consensus/consensus.service.ts');
    expect(paths).toContain('src/modules/webhooks/fanout.ts');
  });

  it('is written by exactly the module that publishes and supersedes', () => {
    expect(decisionWriters(sources)).toEqual([...DECISION_WRITERS].sort());
  });

  it('mutation: another module rewriting an outcome would be caught, by name', () => {
    const offender: SourceFile = {
      path: 'src/modules/consensus/correction.ts',
      source: "await decisions.updateOne(context, { caseId }, { set: { outcome: 'no_violation' } });",
    };

    const found = decisionWriters([...sources, offender]);
    expect(found).toContain('src/modules/consensus/correction.ts');
    expect(found).not.toEqual([...DECISION_WRITERS].sort());
  });

  it('mutation: the scanner really matches a mutating call, not just the word', () => {
    // Without this, a regex that never matched anything would report a clean
    // bill of health for a service full of rewrites.
    expect(DECISION_MUTATION.test('const rows = await decisions.find(context, {});')).toBe(false);
    expect(DECISION_MUTATION.test('await decisions.updateOne(a, b, c);')).toBe(true);
    expect(DECISION_MUTATION.test('await decisions.findOneAndUpdate(a, b);')).toBe(true);
  });
});

describe('the one sanctioned write moves the status and nothing else', () => {
  const service =
    sources.find((file) => file.path === 'src/modules/decision/decision.service.ts')?.source ?? '';

  it('found the service', () => {
    expect(service).toContain('export async function markSuperseded');
    expect(service).toContain('export async function publishDecision');
  });

  /**
   * The fields §9.9 names, plus the two that carry the same weight: a
   * `confidence` or a `jury` rewritten after publication would make a decision
   * unreproducible from its own ballots, which is the same failure as rewriting
   * the outcome wearing a smaller hat.
   */
  const IMMUTABLE_FIELDS = [
    'outcome',
    'findings',
    'policyVersions',
    'confidence',
    'jury',
    'recommendedActions',
    'contextSufficiency',
    'revision',
  ] as const;

  /** The body of every `updateOne` call in the service, as text. */
  function updateBodies(source: string): string[] {
    return [...source.matchAll(/decisions\s*\.\s*updateOne\s*\(([\s\S]*?)\n\s{2}\);/g)].map(
      (match) => match[1],
    );
  }

  it('performs exactly one update against the collection', () => {
    expect(updateBodies(service)).toHaveLength(1);
  });

  it('sets status, and names no field §9.9 protects', () => {
    const [update] = updateBodies(service);

    expect(update).toContain("status: 'superseded'");
    for (const field of IMMUTABLE_FIELDS) {
      expect(update, `the sanctioned update names '${field}'`).not.toMatch(
        new RegExp(`\\b${field}\\s*:`),
      );
    }
  });

  it('mutation: an update that also rewrote the outcome would be caught, by field', () => {
    const mutated = `
  return decisions.updateOne(
    context,
    { caseId, revision, status: 'final' },
    { set: { status: 'superseded', outcome: 'no_violation', updatedAt: now } },
    session,
  );`;

    const [update] = updateBodies(mutated);
    const offending = IMMUTABLE_FIELDS.filter((field) =>
      new RegExp(`\\b${field}\\s*:`).test(update),
    );

    expect(offending).toEqual(['outcome']);
  });

  it('exposes no function that could rewrite a published decision', () => {
    /**
     * The strongest form of the rule: the function that would do it does not
     * exist. A reader looking for "how do I correct a decision" finds
     * `openCaseRevision`, which creates a new one.
     */
    const exported = [...service.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)/g)].map(
      (match) => match[1],
    );

    expect(exported).toEqual([
      'publishDecision',
      'markSuperseded',
      'currentDecision',
      'decisionHistory',
      'decisionView',
    ]);
    expect(exported).not.toContain('updateDecision');
    expect(exported).not.toContain('correctDecision');
  });
});

describe('the compare-and-swap is where publication is serialised', () => {
  const service =
    sources.find((file) => file.path === 'src/modules/decision/decision.service.ts')?.source ?? '';

  it('swaps on the case revision before it inserts anything', () => {
    const swapAt = service.indexOf('cases.updateOne');
    const insertAt = service.indexOf('decisions.insertOne');

    expect(swapAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    /**
     * Order, not merely presence. A decision written first and swapped
     * afterwards would leave the loser of the race having to delete a row it
     * already wrote, inside a transaction it is about to lose.
     */
    expect(swapAt).toBeLessThan(insertAt);
  });

  it('conditions the swap on the revision, not on a status', () => {
    expect(service).toContain('currentRevision: input.revision');
    expect(service).toContain('decidedRevision');
    // `status` has three other writers; a swap conditioned on it would be racing
    // writers it does not know about.
    expect(service).not.toMatch(/updateOne\([\s\S]{0,200}status:\s*\{\s*\$in/);
  });

  it('tolerates a case document written before the field existed', () => {
    /**
     * `$lt` and `$not: { $gte }` differ on a document where the field is ABSENT:
     * `$lt` skips it, `$not` matches it. With `$lt` a case created before this
     * field existed would be permanently undecidable — silently, with the worker
     * reporting "already decided" forever. There is no migration runner yet.
     */
    expect(service).toContain('$not: { $gte: input.revision }');
  });

  it('has a second lock that does not depend on remembering the first', () => {
    const collection =
      sources.find((file) => file.path === 'src/modules/decision/decision.collection.ts')?.source ??
      '';

    expect(collection).toMatch(
      /decisionSchema\.index\(\s*\{\s*caseId:\s*1,\s*revision:\s*1\s*\},\s*\{\s*unique:\s*true\s*\}/,
    );
  });
});
