import { describe, expect, it } from 'vitest';

import {
  APPEAL_REASONS,
  APPEAL_STATUSES,
  AppealSchema,
  AppealSubmissionSchema,
} from '../appeals';
import { CONTRACT_LIMITS } from '../primitives';
import { accepted, rejectionIssues, rejectionPaths } from './support/assertions';
import { appealExample, appealSubmissionExample, decisionExample } from './support/examples';

/**
 * §9.8's appeal, as a contract.
 *
 * The submission is the one inbound payload in the package written by the
 * SUBJECT of a moderation case rather than by an application about its users, so
 * the negative cases below are the point of the file: what a hostile author can
 * put in it, and what the schema refuses to carry.
 */

describe('the appeal vocabulary', () => {
  it('publishes a closed set of reasons', () => {
    expect([...APPEAL_REASONS]).toEqual([
      'context_missing',
      'policy_misapplied',
      'finding_incorrect',
      'exception_applies',
      'not_responsible',
      'procedural_error',
    ]);
  });

  it('has two states, and no verdict of its own', () => {
    /**
     * §9.9 keeps exactly one record of what a case resolved to — the decision
     * revision. An appeal status of `upheld` or `overturned` would be a second,
     * and the two would eventually disagree.
     */
    expect([...APPEAL_STATUSES]).toEqual(['open', 'decided']);
    expect(APPEAL_STATUSES).not.toContain('rejected');
    expect(APPEAL_STATUSES).not.toContain('upheld');
    expect(APPEAL_STATUSES).not.toContain('overturned');
  });
});

describe('the submission a tenant sends', () => {
  it('accepts an appeal with the author’s explanation and structured context', () => {
    const submission = accepted(AppealSubmissionSchema, appealSubmissionExample());

    expect(submission.reason).toBe('context_missing');
    expect(submission.authorContext?.resourceIds).toEqual(['res_post']);
    expect(submission.authorContext?.fields).toEqual({
      publishedBy: 'El País',
      publishedOn: '2026-07-01',
    });
  });

  it('accepts an appeal with no additional context at all', () => {
    const submission = accepted(AppealSubmissionSchema, {
      appellantExternalPrincipalId: 'mention_user_55',
      reason: 'policy_misapplied',
    });

    expect(submission.authorContext).toBeUndefined();
  });

  it('refuses a caseId, a decisionId or an applicationId', () => {
    /**
     * The case comes from the route, the revision from the case, the application
     * from the credential. A submission that carried any of them would be a way
     * to appeal a decision of a case the caller was never handed — the same hole
     * as a review submission that accepted a case id.
     */
    for (const field of ['caseId', 'decisionId', 'applicationId', 'decisionRevision']) {
      const issues = rejectionIssues(AppealSubmissionSchema, {
        ...appealSubmissionExample(),
        [field]: 'case_01HZ',
      });

      // A strict object reports an unrecognised key at the OBJECT's path, naming
      // the key in the message — so the message is what has to be asserted, or
      // the test would pass for any rejection at all.
      expect(issues.map((issue) => issue.path), `${field} was tolerated`).toEqual(['']);
      expect(issues[0].message, `${field} was tolerated`).toContain(field);
    }
  });

  it('requires a reason from the closed list', () => {
    expect(
      rejectionPaths(AppealSubmissionSchema, {
        ...appealSubmissionExample(),
        reason: 'because_i_disagree',
      }),
    ).toEqual(['reason']);
  });

  it('requires the appellant, because who filed it is what makes it eligible', () => {
    const { appellantExternalPrincipalId, ...withoutAppellant } = appealSubmissionExample();
    expect(appellantExternalPrincipalId).toBeDefined();
    expect(rejectionPaths(AppealSubmissionSchema, withoutAppellant)).toEqual([
      'appellantExternalPrincipalId',
    ]);
  });

  it('bounds the statement rather than accepting a corpus', () => {
    const tooLong = {
      ...appealSubmissionExample(),
      authorContext: { statement: 'a'.repeat(CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH + 1) },
    };

    expect(rejectionPaths(AppealSubmissionSchema, tooLong)).toEqual([
      'authorContext.statement',
    ]);
  });

  it('refuses an empty statement, which says nothing and still costs a revision', () => {
    expect(
      rejectionPaths(AppealSubmissionSchema, {
        ...appealSubmissionExample(),
        authorContext: { statement: '' },
      }),
    ).toEqual(['authorContext.statement']);
  });

  it('refuses new evidence smuggled in as a URL or a blob', () => {
    /**
     * Evidence enters through §10.2's upload endpoints, where it is hashed and
     * its type checked. A URL here would be an unvalidated resource on a
     * reviewer's screen, which §7.2.7 exists to prevent.
     */
    const issues = rejectionIssues(AppealSubmissionSchema, {
      ...appealSubmissionExample(),
      authorContext: {
        statement: 'see the attached proof',
        evidenceUrl: 'https://author.invalid/proof.png',
      },
    });

    expect(issues.map((issue) => issue.path)).toEqual(['authorContext']);
    expect(issues[0].message).toContain('evidenceUrl');
  });

  it('keeps structured context flat, scalar and free of prototype keys', () => {
    expect(
      rejectionPaths(AppealSubmissionSchema, {
        ...appealSubmissionExample(),
        authorContext: {
          statement: 'nested',
          fields: { nested: { deeper: 'value' } },
        },
      }).length,
    ).toBeGreaterThan(0);

    expect(
      rejectionPaths(AppealSubmissionSchema, {
        ...appealSubmissionExample(),
        authorContext: { statement: 'polluted', fields: { constructor: 'x' } },
      }).length,
    ).toBeGreaterThan(0);
  });

  it('carries hostile text through unchanged, because that is the material', () => {
    /**
     * The mirror image of the rule above, and it is deliberate: an author
     * defending a post that quoted a threat has to be able to quote it back. The
     * boundary is structural — bounded, flat, scalar — never lexical. Redaction
     * of what a reviewer is SHOWN happens in the backend (§9.8), not by refusing
     * to accept the sentence.
     */
    const submission = accepted(AppealSubmissionSchema, {
      ...appealSubmissionExample(),
      authorContext: { statement: '<script>alert(1)</script> javascript:void(0) ../../etc/passwd' },
    });

    expect(submission.authorContext?.statement).toContain('<script>');
  });
});

describe('the appeal as it travels back', () => {
  it('accepts an open appeal with no decision yet', () => {
    const appeal = accepted(AppealSchema, appealExample());

    expect(appeal.status).toBe('open');
    expect(appeal.openedRevision).toBe(2);
    expect(appeal.decision).toBeUndefined();
  });

  it('accepts a decided appeal carrying the decision at the revision it opened', () => {
    const appeal = accepted(AppealSchema, {
      ...appealExample(),
      status: 'decided',
      decision: { ...decisionExample(), revision: 2, supersedesDecisionId: 'dec_01HZ' },
    });

    expect(appeal.decision?.revision).toBe(2);
  });

  it('refuses an appeal that skips a revision', () => {
    expect(
      rejectionIssues(AppealSchema, { ...appealExample(), openedRevision: 3 }).map(
        (issue) => issue.path,
      ),
    ).toEqual(['openedRevision']);
  });

  it('refuses a decided appeal with nothing that decided it', () => {
    expect(
      rejectionPaths(AppealSchema, { ...appealExample(), status: 'decided' }),
    ).toEqual(['decision']);
  });

  it('refuses an open appeal that carries a decision', () => {
    expect(
      rejectionPaths(AppealSchema, {
        ...appealExample(),
        decision: { ...decisionExample(), revision: 2, supersedesDecisionId: 'dec_01HZ' },
      }),
    ).toEqual(['status']);
  });

  it('refuses a decision from a different revision than the one it opened', () => {
    expect(
      rejectionPaths(AppealSchema, {
        ...appealExample(),
        status: 'decided',
        decision: { ...decisionExample(), revision: 3, supersedesDecisionId: 'dec_01HZ' },
      }),
    ).toEqual(['decision.revision']);
  });

  it('passes unknown fields through, like every outbound contract', () => {
    const appeal = accepted(AppealSchema, { ...appealExample(), overturnRate: 0.12 });
    expect(appeal.overturnRate).toBe(0.12);
  });
});
