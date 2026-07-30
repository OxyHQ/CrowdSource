/**
 * PLAN §9.1 — the blindness rules, tested against a server that breaks them.
 *
 * The fixture below is a hostile assignment payload: it carries every field the
 * reviewer must never see, at several depths, alongside the legitimate case
 * material.
 *
 * What "enforcement" means here changed, and the change is the point. The
 * projection used to COPY an allowlist of fields, which meant a forbidden field
 * was dropped and the screen rendered anyway. It now PARSES against the published
 * contract's strict schemas, so a payload carrying a report count or an author's
 * reputation is REFUSED. That is the better direction for this surface: a screen
 * that fails to render is a bug somebody fixes today, and an author's reputation
 * on screen is a bug nobody notices.
 *
 * `scanForForbiddenFields` still runs first and still reports paths only, so the
 * breach stays diagnosable — which matters more now, because the parse's own
 * message names one field and stops.
 */

import { MalformedPayloadError } from '@/lib/reviewer-api/errors';
import {
  FORBIDDEN_FIELD_PATTERNS,
  projectAssignmentPackage,
  projectIssuedAssignment,
  scanForForbiddenFields,
} from '@/lib/reviewer-api/redaction';

/** The half of §9.1 the reviewer is entitled to, in the shape the API sends. */
function legitimateAssignment() {
  return {
    assignmentId: 'asg_01HQ',
    caseRevision: 1,
    expiresAt: '2026-07-28T12:00:00.000Z',
    language: 'en-US',
    families: ['harassment'],
    allegations: { unverified: true, codes: ['harassment.insult'] },
    policy: {
      policySetId: 'mention.community',
      version: '2026.1.0',
      taxonomyVersion: '2026.1',
      rules: [
        {
          id: 'mention.harassment.2',
          title: 'Targeted abuse',
          description: 'Do not target a person with abuse.',
          taxonomyCodes: ['harassment.targeted_abuse'],
        },
      ],
    },
    presentation: {
      sensitivityClass: 'sensitive',
      requiresRedaction: false,
      blurBeforeReveal: true,
    },
    resources: [
      {
        id: 'res_1',
        type: 'text',
        role: 'subject',
        data: { text: 'the reported text' },
      },
      {
        id: 'res_2',
        type: 'image',
        role: 'attachment',
        asset: { mediaType: 'image/png', retrievable: true, fileId: 'file_1' },
      },
    ],
    relations: [{ from: 'res_1', type: 'has_attachment', to: 'res_2' }],
    watermark: 'aaaa-bbbb-cccc',
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
          type: 'text',
          role: 'subject',
          data: { text: 'the reported text' },
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

  it('does not fire on the envelope-scoped author pseudonym', () => {
    /**
     * `authorPrincipalRef` is on the reviewer surface DELIBERATELY: §9.1 hides the
     * author's identity and reputation, and a ref that resolves to nothing outside
     * one case is neither. Which resources share an author is the context a
     * harassment allegation cannot be judged without, and a pattern that caught it
     * would make the alarm fire on every legitimate payload.
     */
    expect(scanForForbiddenFields({ authorPrincipalRef: 'author_1' })).toEqual([]);
  });
});

describe('projectAssignmentPackage', () => {
  it('refuses a payload carrying every §9.1 field, rather than trimming them', () => {
    expect(() =>
      projectAssignmentPackage({ ...legitimateAssignment(), ...forbiddenFields() }),
    ).toThrow(MalformedPayloadError);
  });

  it.each(Object.entries(forbiddenFields()))(
    'refuses a payload carrying %s alone',
    (key, value) => {
      // One at a time, so a refusal cannot be passing because of some OTHER field
      // in the hostile bundle.
      expect(() => projectAssignmentPackage({ ...legitimateAssignment(), [key]: value })).toThrow(
        MalformedPayloadError,
      );
    },
  );

  it('refuses a forbidden field nested inside a resource', () => {
    expect(() =>
      projectAssignmentPackage({
        ...legitimateAssignment(),
        resources: [
          {
            id: 'res_1',
            type: 'text',
            role: 'subject',
            data: { text: 'the reported text' },
            authorReputation: 12,
          },
        ],
      }),
    ).toThrow(MalformedPayloadError);
  });

  it('refuses an asset locator, which would name the reporting application', () => {
    /**
     * The §9.1 leak that was actually live: the backend shipped the envelope's
     * resources raw, `asset.url` included — a URL on the reporting application's
     * own host, straight onto the review screen.
     */
    expect(() =>
      projectAssignmentPackage({
        ...legitimateAssignment(),
        resources: [
          {
            id: 'res_2',
            type: 'image',
            role: 'attachment',
            asset: {
              mediaType: 'image/png',
              retrievable: true,
              url: 'https://cdn.some-app.test/photo.png',
            },
          },
        ],
      }),
    ).toThrow(MalformedPayloadError);
  });

  it('keeps everything a reviewer IS entitled to', () => {
    const projected = projectAssignmentPackage(legitimateAssignment());

    // Nothing forbidden survived…
    expect(scanForForbiddenFields(projected)).toEqual([]);
    // …and the material itself did, so the check above is not passing because the
    // projection returned an empty husk.
    expect(projected.assignmentId).toBe('asg_01HQ');
    expect(projected.families).toEqual(['harassment']);
    expect(projected.allegations.codes).toEqual(['harassment.insult']);
    expect(projected.policy.rules[0]?.taxonomyCodes).toEqual(['harassment.targeted_abuse']);
    expect(projected.presentation.sensitivityClass).toBe('sensitive');
    expect(projected.relations).toHaveLength(1);
    expect(projected.watermark).toBe('aaaa-bbbb-cccc');

    const text = projected.resources[0];
    expect(text?.type === 'text' ? text.data.text : null).toBe('the reported text');
    const image = projected.resources[1];
    expect(image?.type === 'image' ? image.asset.fileId : null).toBe('file_1');
  });

  it('exposes exactly the agreed field set — no more', () => {
    const projected = projectAssignmentPackage(legitimateAssignment());
    // Changing this list means changing what a reviewer can see. That is a §9.1
    // decision, and it should not be possible to make it by accident.
    expect(Object.keys(projected).sort()).toEqual(
      [
        'allegations',
        'assignmentId',
        'caseRevision',
        'expiresAt',
        'families',
        'language',
        'policy',
        'presentation',
        'relations',
        'resources',
        'watermark',
      ].sort(),
    );
  });

  it('rejects a payload that does not match the contract, by field path', () => {
    const broken = legitimateAssignment();
    // A malformed assignment is still case material, so the error names the path
    // and never the value.
    expect(() => projectAssignmentPackage({ ...broken, assignmentId: 42 })).toThrow(
      'assignment.assignmentId',
    );
    expect(() =>
      projectAssignmentPackage({
        ...broken,
        presentation: { ...broken.presentation, sensitivityClass: 'spicy' },
      }),
    ).toThrow('assignment.presentation.sensitivityClass');
  });

  it('refuses `prohibited` material, which §7.5 never sends to a jury', () => {
    expect(() =>
      projectAssignmentPackage({
        ...legitimateAssignment(),
        presentation: {
          sensitivityClass: 'prohibited',
          requiresRedaction: true,
          blurBeforeReveal: true,
        },
      }),
    ).toThrow('assignment.presentation.sensitivityClass');
  });
});

describe('projectIssuedAssignment', () => {
  it('requires §8.7’s token, which is returned exactly once', () => {
    /**
     * Without this the token would be dropped silently and every later call on the
     * assignment would 404 — indistinguishable from an expiry, three screens from
     * the cause. This is the bug the app shipped with: it never read the token at
     * all.
     */
    expect(() => projectIssuedAssignment(legitimateAssignment())).toThrow('assignment.token');
  });

  it('accepts the issued package and carries the token through', () => {
    const issued = projectIssuedAssignment({ ...legitimateAssignment(), token: 'tok_abc' });
    expect(issued.token).toBe('tok_abc');
    expect(issued.assignmentId).toBe('asg_01HQ');
  });

  it('refuses a token on the plain package, where it does not belong', () => {
    expect(() => projectAssignmentPackage({ ...legitimateAssignment(), token: 'tok_abc' })).toThrow(
      MalformedPayloadError,
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
