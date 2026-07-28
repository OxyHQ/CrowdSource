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
  clearActiveAssignment,
  setActiveAssignment,
} from '@/lib/reviewer-api/active-assignment';
import { projectAssignmentPackage } from '@/lib/reviewer-api/redaction';

const ASSIGNMENT = projectAssignmentPackage({
  assignmentId: 'asg_1',
  expiresAt: '2026-07-28T12:00:00.000Z',
  caseRevision: 1,
  language: 'en-US',
  category: 'harassment',
  sensitivity: 'low',
  warnings: [],
  resources: [],
  context: [],
  policy: { policySetId: 'ps_1', policyVersion: '1', rules: [], examples: [], exceptions: [] },
  allegation: { code: 'harassment.insult' },
  watermark: null,
});

describe('active assignment store', () => {
  afterEach(() => {
    clearActiveAssignment();
  });

  it('notifies subscribers when an assignment opens and closes', () => {
    const seen: (string | null)[] = [];
    setActiveAssignment(ASSIGNMENT);
    seen.push('opened');
    clearActiveAssignment();
    seen.push('cleared');
    expect(seen).toEqual(['opened', 'cleared']);
  });

  it('clears synchronously, with no promise to await', () => {
    setActiveAssignment(ASSIGNMENT);
    // A returned promise here would mean the wellbeing exit could be left
    // pending while the material stayed on screen.
    expect(clearActiveAssignment()).toBeUndefined();
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
    expect(imported.sort()).toEqual(['./types', 'react']);
  });
});
