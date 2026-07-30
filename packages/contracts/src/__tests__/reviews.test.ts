import { describe, expect, it } from 'vitest';

import { RecusalSubmissionSchema, ReviewSubmissionSchema } from '../reviews.js';
import { accepted, rejectionIssues, rejectionPaths } from './support/assertions.js';
import { reviewSubmissionExample } from './support/examples.js';

describe('ReviewSubmissionSchema', () => {
  it('accepts §9.3\'s result shape', () => {
    const review = accepted(ReviewSubmissionSchema, reviewSubmissionExample());
    expect(review.outcome).toBe('violation');
    expect(review.findings[0]?.confidence).toBe(0.88);
  });

  it('accepts a note, since §9.3 allows one', () => {
    expect(
      accepted(ReviewSubmissionSchema, {
        ...reviewSubmissionExample(),
        notes: 'The reply quotes the parent message.',
      }).notes,
    ).toBeDefined();
  });

  it('refuses to carry the case, the assignment or the reviewer', () => {
    /**
     * "Nobody chooses the case they review." The assignment id comes from the
     * route and everything else is derived from it server-side. Strict makes
     * these fields impossible rather than merely ignored — an ignored field is
     * one refactor away from being read.
     */
    for (const smuggled of [
      { caseId: 'case_01HZ' },
      { assignmentId: 'asg_01HZ' },
      { reviewerId: 'usr_01HZ' },
    ]) {
      const issues = rejectionIssues(ReviewSubmissionSchema, {
        ...reviewSubmissionExample(),
        ...smuggled,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain(Object.keys(smuggled)[0] ?? '');
    }
  });

  it('refuses outcomes only the consensus engine can reach', () => {
    /**
     * "The absence of consensus is neither guilt nor innocence" only holds if
     * `inconclusive` is something a panel produces, never something a reviewer
     * votes for. `escalated` and `duplicate` are case states for the same
     * reason.
     */
    for (const outcome of ['inconclusive', 'escalated', 'duplicate']) {
      expect(rejectionPaths(ReviewSubmissionSchema, { ...reviewSubmissionExample(), outcome }))
        .toEqual(['outcome']);
    }
  });

  it('rejects a finding of insufficient context that also claims context was sufficient', () => {
    expect(
      rejectionPaths(ReviewSubmissionSchema, {
        ...reviewSubmissionExample(),
        outcome: 'insufficient_context',
        contextSufficiency: 'sufficient',
        findings: [],
      }),
    ).toEqual(['contextSufficiency']);
  });

  it('allows a decisive vote taken on incomplete context, which §9.5 prices in', () => {
    expect(
      accepted(ReviewSubmissionSchema, {
        ...reviewSubmissionExample(),
        contextSufficiency: 'insufficient',
      }).contextSufficiency,
    ).toBe('insufficient');
  });

  it('rejects a violation with nothing found', () => {
    expect(
      rejectionPaths(ReviewSubmissionSchema, { ...reviewSubmissionExample(), findings: [] }),
    ).toEqual(['findings']);
  });

  it('allows findings on a no_violation outcome, as §6.2 describes', () => {
    // A jury can classify material accurately and still conclude this
    // application's policy is not breached.
    expect(
      accepted(ReviewSubmissionSchema, {
        ...reviewSubmissionExample(),
        outcome: 'no_violation',
        findings: [
          {
            code: 'sexual_content.nudity',
            resourceIds: ['res_post'],
            severity: 'low',
            confidence: 0.7,
          },
        ],
      }).findings,
    ).toHaveLength(1);
  });

  it('rejects a finding that does not say which resource it is about', () => {
    expect(
      rejectionPaths(ReviewSubmissionSchema, {
        ...reviewSubmissionExample(),
        findings: [
          {
            code: 'harassment.targeted_abuse',
            resourceIds: [],
            severity: 'medium',
            confidence: 0.5,
          },
        ],
      }),
    ).toEqual(['findings.0.resourceIds']);
  });

  /**
   * §6.2's `context = artistic`, which §9.2 calls the "excepción" of the
   * policy-evaluation step and §9.4 makes one of the six dimensions consensus is
   * measured on.
   *
   * §6.2's own worked example is a jury finding `sexual_content.nudity,
   * severity = medium, context = artistic`, so the field sits beside the code
   * and the severity rather than on the submission: "artistic nudity" is a
   * different description of the material, not a different verdict about it.
   */
  it('accepts §6.2’s context on a finding', () => {
    const review = accepted(ReviewSubmissionSchema, {
      ...reviewSubmissionExample(),
      outcome: 'no_violation',
      findings: [
        {
          code: 'sexual_content.nudity',
          resourceIds: ['res_post'],
          severity: 'medium',
          context: 'artistic',
          confidence: 0.8,
        },
      ],
    });

    expect(review.findings[0]?.context).toBe('artistic');
  });

  it('treats an absent context as "no exception applies"', () => {
    // Absence is the safe direction: a finding with no exception stands as
    // classified. It is optional for that reason, not by oversight.
    expect(accepted(ReviewSubmissionSchema, reviewSubmissionExample()).findings[0]?.context).toBeUndefined();
  });

  it('refuses an exception the taxonomy does not name', () => {
    /**
     * §9.4 compares this field between reviewers. A free-text exception could
     * never be compared — two jurors typing the same idea differently would read
     * as a disagreement — and would be a channel for case content to reach a
     * decision record, which §13.5 forbids.
     */
    expect(
      rejectionPaths(ReviewSubmissionSchema, {
        ...reviewSubmissionExample(),
        findings: [
          {
            code: 'harassment.targeted_abuse',
            resourceIds: ['res_post'],
            severity: 'medium',
            context: 'because it was a joke between friends',
            confidence: 0.5,
          },
        ],
      }),
    ).toEqual(['findings.0.context']);
  });

  it('rejects a confidence outside [0, 1]', () => {
    expect(
      rejectionPaths(ReviewSubmissionSchema, {
        ...reviewSubmissionExample(),
        findings: [
          {
            code: 'harassment.targeted_abuse',
            resourceIds: ['res_post'],
            severity: 'medium',
            confidence: 1.5,
          },
        ],
      }),
    ).toEqual(['findings.0.confidence']);
  });
});

describe('RecusalSubmissionSchema', () => {
  it('accepts the four reasons §4.1 lists', () => {
    for (const reason of ['conflict_of_interest', 'language', 'too_sensitive', 'insufficient_context']) {
      expect(accepted(RecusalSubmissionSchema, { reason }).reason).toBe(reason);
    }
  });

  it('rejects an unstructured reason', () => {
    expect(rejectionPaths(RecusalSubmissionSchema, { reason: 'not interested' })).toEqual([
      'reason',
    ]);
  });
});
