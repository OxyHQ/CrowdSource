/**
 * The plan's own reference payloads, parsed by the contract that claims to
 * describe them.
 *
 * Appendix A, Appendix B, §5.8 and §10.7 are stored verbatim under `fixtures/`.
 * Three of them validate; where one does not, this suite states exactly which
 * token is responsible and why the contract prefers to reject it. A divergence
 * from an approved specification that nobody can point at is how a contract
 * stops matching its documentation.
 */

import { describe, expect, it } from 'vitest';

import { CaseEnvelopeSchema } from '../case-envelope';
import { DecisionSchema } from '../decisions';
import { KnownWebhookEventSchema, WebhookEventEnvelopeSchema } from '../webhooks';
import { accepted, expandPlaceholders, readFixture, rejectionPaths } from './support/assertions';

/**
 * The elisions the appendices write where a real value belongs.
 *
 * Only digests need expanding. `bind_01...`, `upload_01...`, `dec_01...` and
 * `case_01...` are all well-formed identifiers as written and are left alone —
 * the contract keeps identifiers opaque precisely so a slug, a ULID and the
 * plan's shorthand are all acceptable.
 */
const APPENDIX_A_EXPANSIONS = Object.freeze({
  'sha256:...': `sha256:${'a'.repeat(64)}`,
});

/** §5.8 elides the same value differently — see the digest note below. */
const SECTION_5_8_EXPANSIONS = Object.freeze({
  '...': `sha256:${'b'.repeat(64)}`,
});

describe('Appendix A — the reference Case Envelope', () => {
  const verbatim = readFixture('appendix-a.case-envelope.json');

  it('rejects the verbatim appendix at exactly the elided digests, and nowhere else', () => {
    /**
     * This is the one place the contract knowingly refuses a reference document
     * as written, and the assertion is deliberately exhaustive: the ONLY
     * complaints are the three `"sha256:..."` placeholders. Everything else in
     * Appendix A — every field name, every enum value, every reference between
     * resources — is accepted exactly as the plan writes it.
     */
    expect(rejectionPaths(CaseEnvelopeSchema, verbatim)).toEqual([
      'resources.0.sha256',
      'resources.1.asset.sha256',
      'resources.2.sha256',
    ]);
  });

  it('accepts the appendix once the elided digests carry a real value', () => {
    const { value, used } = expandPlaceholders(verbatim, APPENDIX_A_EXPANSIONS);

    // Vacuity floor: if the appendix stopped using this placeholder, the
    // expansion above would quietly become a no-op and this suite would go on
    // "passing" while testing a document nobody edited.
    expect(used).toEqual(['sha256:...']);

    const envelope = accepted(CaseEnvelopeSchema, value);
    expect(envelope.schemaVersion).toBe('crowdsource.case.v1');
    expect(envelope.resources).toHaveLength(3);
    expect(envelope.subject.primaryResourceId).toBe('res_post');
  });
});

describe('§5.8 — the universal example for Mention', () => {
  const verbatim = readFixture('plan-5-8.case-envelope.json');

  it('rejects the bare digest notation §5.8 uses', () => {
    /**
     * §5.8 writes `"sha256": "..."` where Appendix A writes
     * `"sha256": "sha256:..."`. Both elide the same value, but they imply two
     * different notations for it, and a digest that can be written two ways
     * hashes two ways — which would give one piece of content two envelope
     * hashes, two `caseDedupKey`s, two cases and two penalties for one
     * incident. Appendix A is the reference document, so the prefixed form is
     * the contract and the bare form is rejected rather than normalised.
     */
    expect(rejectionPaths(CaseEnvelopeSchema, verbatim)).toEqual([
      'resources.0.sha256',
      'resources.1.asset.sha256',
    ]);
  });

  it('accepts it with a canonical digest, without any of the optional blocks', () => {
    const { value, used } = expandPlaceholders(verbatim, SECTION_5_8_EXPANSIONS);
    expect(used).toEqual(['...']);

    const envelope = accepted(CaseEnvelopeSchema, value);
    // §5.8 omits `source`, `urgency` and `metadata` entirely, which is what
    // makes those three optional and the other seven root keys required.
    expect(envelope.source).toBeUndefined();
    expect(envelope.urgency).toBeUndefined();
    expect(envelope.metadata).toBeUndefined();
  });
});

describe('Appendix B — the reference Decision', () => {
  const verbatim = readFixture('appendix-b.decision.json');

  it('validates exactly as written, with no expansion at all', () => {
    const decision = accepted(DecisionSchema, verbatim);
    expect(decision.outcome).toBe('violation');
    expect(decision.revision).toBe(1);
    expect(decision.supersedesDecisionId).toBeUndefined();
  });

  it('carries all three policy versions §6.4 requires', () => {
    const decision = accepted(DecisionSchema, verbatim);
    expect(decision.policyVersions).toEqual({
      taxonomy: '2026.1',
      application: 'mention.2026.07',
      oxyConduct: 'oxy.2026.1',
    });
  });

  it('states an agreement that matches the votes it reports', () => {
    const decision = accepted(DecisionSchema, verbatim);
    expect(decision.jury.agreement).toBe(decision.jury.winningVotes / decision.jury.decisiveVotes);
  });
});

describe('§10.7 — the webhook example', () => {
  const verbatim = readFixture('plan-10-7.webhook-case-decided.json');

  it('is a valid envelope, so a receiver can verify and dedupe it', () => {
    /**
     * The generic envelope validates whatever §10.7 sends, because a receiver
     * must be able to check the signature and record the event id before it
     * knows anything about the payload (§10.8, §10.11).
     */
    const envelope = accepted(WebhookEventEnvelopeSchema, verbatim);
    expect(envelope.type).toBe('case.decided');
    expect(envelope.id).toBe('evt_01...');
  });

  it('does not match the typed contract, and the divergence is deliberate', () => {
    /**
     * §10.7's embedded decision is a sketch, not Appendix B: it writes
     * `recommendedActions` as bare strings, omits `caseId`, `contextSufficiency`,
     * `jury`, `policyVersions` and `publishedAt`, and drops `attribution` and
     * `policyRuleIds` from the finding.
     *
     * Appendix B is the reference Decision and wins. The object form of
     * `recommendedActions` is the substantive difference: a decision that says
     * "remove or restrict" without naming what to remove is not actionable, and
     * an application acting on it is guessing. The missing fields are all
     * required by §12.8, which marks only `supersedes_decision_id` nullable.
     *
     * This test exists so that divergence is executable rather than a footnote:
     * if someone later widens the decision contract to accept §10.7's shape,
     * this fails and they have to decide that on purpose.
     */
    expect(rejectionPaths(KnownWebhookEventSchema, verbatim).sort()).toEqual([
      'data.decision.caseId',
      'data.decision.contextSufficiency',
      'data.decision.jury',
      'data.decision.policyVersions',
      'data.decision.publishedAt',
      'data.decision.recommendedActions.0',
    ]);
  });
});
