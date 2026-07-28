/**
 * PLAN §9.1 — the blindness rules, tested against a server that breaks them.
 *
 * The fixture below is a hostile assignment payload: it carries every field the
 * reviewer must never see, at several depths, alongside the legitimate case
 * material. If the projection is enforcement rather than decoration, none of the
 * forbidden fields can appear in its output no matter how the screens are
 * written afterwards.
 */

import {
  FORBIDDEN_FIELD_PATTERNS,
  projectAssignmentPackage,
  scanForForbiddenFields,
} from '@/lib/reviewer-api/redaction';

/** The half of §9.1 the reviewer is entitled to. */
function legitimateAssignment() {
  return {
    assignmentId: 'asg_01HQ',
    expiresAt: '2026-07-28T12:00:00.000Z',
    caseRevision: 1,
    language: 'en-US',
    category: 'harassment',
    sensitivity: 'high',
    warnings: ['graphic_language'],
    resources: [
      { id: 'res_1', kind: 'text', text: 'the reported text', sensitive: false, warnings: [] },
      { id: 'res_2', kind: 'image', fileId: 'file_1', sensitive: true, warnings: ['nudity'] },
    ],
    context: [{ id: 'ctx_1', text: 'the message this replied to' }],
    policy: {
      policySetId: 'policy_set_1',
      policyVersion: '3',
      rules: [
        {
          id: 'rule_1',
          title: 'Targeted abuse',
          text: 'Do not target a person with abuse.',
          taxonomyCode: 'harassment.targeted_abuse',
        },
      ],
      examples: [{ id: 'ex_1', text: 'an example', violating: true }],
      exceptions: [{ id: 'exc_1', title: 'Satire', text: 'Clearly satirical material.' }],
    },
    allegation: { code: 'harassment.insult', statement: 'they insulted me' },
    watermark: 'wm-7Q2K',
  };
}

/**
 * Every row of the §9.1 "Ocultar" column, planted at the depths a real leak
 * would take: the root, inside a resource, and inside the policy brief.
 */
function forbiddenFields() {
  return {
    reportCount: 47,
    totalReports: 47,
    reporter: { id: 'usr_a', handle: 'someone', reputation: 900 },
    reporterId: 'usr_a',
    reporterReputation: 900,
    author: { id: 'usr_b', handle: 'author', reputation: 12 },
    authorId: 'usr_b',
    authorReputation: 12,
    subjectReputation: 12,
    subjectStanding: 'good',
    reputation: 12,
    votes: [{ reviewerId: 'usr_c', outcome: 'violation' }],
    voteCount: 2,
    partialResult: 'violation',
    provisionalOutcome: 'violation',
    tally: { violation: 2, no_violation: 0 },
    jurors: ['usr_c', 'usr_d'],
    jury: { members: ['usr_c'] },
    reviewerIds: ['usr_c'],
    applicationName: 'SomeApp',
    applicationLogo: 'file_logo',
    brand: 'SomeApp',
    popularity: 9000,
    likes: 400,
    followers: 120000,
    isVerified: true,
  };
}

describe('scanForForbiddenFields', () => {
  it('names every §9.1 field a payload carries, at every depth', () => {
    const payload = {
      ...legitimateAssignment(),
      ...forbiddenFields(),
      resources: [
        {
          id: 'res_1',
          kind: 'text',
          text: 'the reported text',
          sensitive: false,
          warnings: [],
          authorReputation: 12,
          reportCount: 47,
        },
      ],
      policy: { ...legitimateAssignment().policy, applicationName: 'SomeApp' },
    };

    const paths = scanForForbiddenFields(payload);

    // Vacuity floor: a scanner that walked nothing would return an empty array
    // and read exactly like a clean payload.
    expect(paths.length).toBeGreaterThanOrEqual(Object.keys(forbiddenFields()).length);

    for (const key of Object.keys(forbiddenFields())) {
      expect(paths).toContain(key);
    }
    expect(paths).toContain('resources[0].authorReputation');
    expect(paths).toContain('resources[0].reportCount');
    expect(paths).toContain('policy.applicationName');
  });

  it('finds nothing in a payload that respects §9.1', () => {
    expect(scanForForbiddenFields(legitimateAssignment())).toEqual([]);
  });

  it('reports truncation rather than stopping silently', () => {
    // Deeper than MAX_SCAN_DEPTH. A bounded walk that gave up quietly would be
    // indistinguishable from a clean scan.
    let deep: Record<string, unknown> = { reportCount: 1 };
    for (let level = 0; level < 40; level += 1) {
      deep = { nested: deep };
    }
    expect(scanForForbiddenFields(deep)).toContain('<scan-truncated>');
  });

  it('does not fire on legitimate field names that merely look similar', () => {
    // A pattern too eager to be trusted gets switched off by whoever it blocks,
    // which costs the whole alarm.
    expect(
      scanForForbiddenFields({
        reportedAt: '2026-07-28T00:00:00.000Z',
        authorized: true,
        reportingLanguage: 'en-US',
        voteDeadline: '2026-07-29T00:00:00.000Z',
      }),
    ).toEqual([]);
  });
});

describe('projectAssignmentPackage', () => {
  it('drops every §9.1 field, keeping only what a reviewer may see', () => {
    const projected = projectAssignmentPackage({
      ...legitimateAssignment(),
      ...forbiddenFields(),
    });

    // The real assertion: scan the RESULT. Naming individual fields would only
    // prove the ones this test happened to think of.
    expect(scanForForbiddenFields(projected)).toEqual([]);

    // …and the material itself survived, so the check above is not passing
    // because the projection returned an empty husk.
    expect(projected.assignmentId).toBe('asg_01HQ');
    expect(projected.resources).toHaveLength(2);
    expect(projected.resources[0].text).toBe('the reported text');
    expect(projected.policy.rules[0].taxonomyCode).toBe('harassment.targeted_abuse');
    expect(projected.allegation.code).toBe('harassment.insult');
    expect(projected.watermark).toBe('wm-7Q2K');
  });

  it('exposes exactly the agreed field set — no more', () => {
    const projected = projectAssignmentPackage(legitimateAssignment());
    // Changing this list means changing what a reviewer can see. That is a
    // §9.1 decision, and it should not be possible to make it by accident.
    expect(Object.keys(projected).sort()).toEqual(
      [
        'allegation',
        'assignmentId',
        'caseRevision',
        'category',
        'context',
        'expiresAt',
        'language',
        'policy',
        'resources',
        'sensitivity',
        'warnings',
        'watermark',
      ].sort(),
    );
  });

  it('drops a forbidden field nested inside a resource', () => {
    const projected = projectAssignmentPackage({
      ...legitimateAssignment(),
      resources: [
        {
          id: 'res_1',
          kind: 'text',
          text: 'the reported text',
          sensitive: false,
          warnings: [],
          authorReputation: 12,
          reporterId: 'usr_a',
        },
      ],
    });
    expect(Object.keys(projected.resources[0]).sort()).toEqual(
      ['fileId', 'id', 'kind', 'mediaType', 'sensitive', 'text', 'url', 'warnings'].sort(),
    );
    expect(scanForForbiddenFields(projected)).toEqual([]);
  });

  it('rejects a payload that does not match the contract, by field path', () => {
    const broken = legitimateAssignment();
    // A malformed assignment is still case material, so the error names the
    // path and never the value.
    expect(() => projectAssignmentPackage({ ...broken, assignmentId: 42 })).toThrow(
      'assignment.assignmentId',
    );
    expect(() => projectAssignmentPackage({ ...broken, sensitivity: 'spicy' })).toThrow(
      'assignment.sensitivity',
    );
  });
});

describe('FORBIDDEN_FIELD_PATTERNS', () => {
  it('has no pattern that matches nothing in the known leak set', () => {
    // A dead pattern is a hole nobody can see. Every pattern must earn its place
    // by matching at least one field name we know a server could send.
    const knownKeys = Object.keys(forbiddenFields());
    for (const pattern of FORBIDDEN_FIELD_PATTERNS) {
      expect(knownKeys.some((key) => pattern.test(key))).toBe(true);
    }
  });
});
