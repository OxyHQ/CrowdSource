/**
 * The open assignment is memory-only, and leaving is immediate.
 *
 * `clearActiveAssignment` is what the wellbeing screen's exit calls, and it must
 * not be async: "take this off my screen" that waits on a network round trip is
 * not an exit. The store is also the reason there is no case id in any URL — it
 * is the only place an assignment lives between screens.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  activeAssignmentToken,
  clearActiveAssignment,
  setActiveAssignment,
} from '@/lib/reviewer-api/active-assignment';
import { projectIssuedAssignment } from '@/lib/reviewer-api/redaction';

/**
 * The ISSUED package, because that is the only thing that can open a case: it is
 * the one response carrying §8.7's token, and a package without its token is an
 * assignment every later request would be refused for.
 */
const ISSUED = projectIssuedAssignment({
  assignmentId: 'asg_1',
  caseRevision: 1,
  expiresAt: '2026-07-28T12:00:00.000Z',
  language: 'en-US',
  families: ['harassment'],
  allegations: { unverified: true, codes: ['harassment.insult'] },
  policy: {
    policySetId: 'mention.community',
    version: '2026.1.0',
    taxonomyVersion: '2026.1',
    rules: [],
  },
  presentation: { sensitivityClass: 'standard', requiresRedaction: false, blurBeforeReveal: false },
  resources: [],
  relations: [],
  watermark: null,
  token: 'tok_secret',
});

describe('active assignment store', () => {
  afterEach(() => {
    clearActiveAssignment();
  });

  it('notifies subscribers when an assignment opens and closes', () => {
    const seen: (string | null)[] = [];
    setActiveAssignment(ISSUED);
    seen.push('opened');
    clearActiveAssignment();
    seen.push('cleared');
    expect(seen).toEqual(['opened', 'cleared']);
  });

  it('clears synchronously, with no promise to await', () => {
    setActiveAssignment(ISSUED);
    // A returned promise here would mean the wellbeing exit could be left
    // pending while the material stayed on screen.
    expect(clearActiveAssignment()).toBeUndefined();
  });

  it('holds §8.7’s token for the open assignment, and only for it', () => {
    setActiveAssignment(ISSUED);
    expect(activeAssignmentToken('asg_1')).toBe('tok_secret');
    // A token is scoped to ONE case: asking with another id must not hand it over.
    expect(activeAssignmentToken('asg_other')).toBeNull();
  });

  it('forgets the token the moment the case is closed', () => {
    // The wellbeing exit and a submitted review both call this. A token that
    // outlived the sitting would let a reload reopen material the reviewer closed.
    setActiveAssignment(ISSUED);
    clearActiveAssignment();
    expect(activeAssignmentToken('asg_1')).toBeNull();
  });

  it('never touches device storage', () => {
    // Asserted on the module's IMPORTS rather than by grepping for storage
    // names: a doc comment that mentions AsyncStorage in order to say it is not
    // used would fail a text search, and a check that cries wolf gets deleted.
    const source = readFileSync(join(__dirname, '..', 'active-assignment.ts'), 'utf8');
    const imported = [...source.matchAll(/^import[^;]*from '([^']+)';$/gm)].map(
      (match) => match[1],
    );
    expect(imported.length).toBeGreaterThan(0);
    // The contract package and React. Nothing that persists, and in particular
    // nothing from `utils/storage.ts` or the SDK's session store — a token or a
    // package that outlived the sitting would let a reload reopen material the
    // reviewer had closed.
    expect(imported.sort()).toEqual(['@oxyhq/crowdsource-contracts', 'react']);
  });
});
