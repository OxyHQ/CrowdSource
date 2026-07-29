# ADR 0003 — Five reputation axes, never one number

- **Status**: accepted
- **Date**: 2026-07-30
- **Evidence**: production audit of Oxy Trust V1, recorded in `.plan/READINESS-OXYTRUST.md` (read-only audit of `OxyHQServices` at `origin/main` = `e2def02e`, plus a read-only sweep of the production MongoDB cluster)

## Context

Oxy Trust V1 exists and is deployed. §11.1 of the plan is explicit that
CrowdSource extends it rather than replacing it, and the reusable parts are real:
an append-only ledger, idempotency by `applicationId` + `sourceActionId`,
compensating reversals, voids, and signed attestations.

But V1 models a person as **one number**, `ReputationBalance.total`, with a
`trustTier` derived from it. Every decision the civic system makes — who may sit
on a jury, how much their vote is worth, whether an account is restricted — comes
out of that one number. CrowdSource cannot inherit it, and the reason is not a
design preference. It is what the production data says happened.

## The findings that decide this

These are measured facts from production, not projections. They are recorded here
because a rationale that reads as opinion gets re-litigated, and this one should
not be.

| Finding | Measurement |
| --- | --- |
| **No user has ever reached the jury-eligibility threshold.** `trusted` requires `total >= 100`. | `balances_total_gte_100: 0` across 74 `reputationbalances`. Tier distribution: `new=69`, `verified=5`, `trusted=0`, `high_trust=0`. |
| **The jury pool is the operator's own accounts.** The 5 pool candidates qualify by `User.verified`, not by reputation earned, and all have `total = 0`. | `verified_usernames: nate, oxy, mention, homiio, nateisern, oxy-org` |
| **Twenty of twenty-one validation requests expired.** Every jury ever opened aged out at 48h without reaching quorum. | `validationrequests: 21 → expired: 20, pending: 1` |
| **Not one vote has ever been cast.** | `validationvotes: 0` |
| **A signed attestation has never been emitted.** `attestAward` is only reached with `emitAttestation: true`, set in three places, none of which has ever fired. | `signedrecords: 0` documents |
| **The karma migration is not the cause and would not be the cure.** No karma data exists in any database in the cluster; the 62 existing transactions are all `endorsement_received`, an action type of the new code, dated after the 2026-06-16 replacement. | `karmas: 0`, `karmarules: 0`, `karma_history_entries: 0` |
| **The web-of-trust genesis is two accounts.** | `users_isSeedVerifier_true: 2` (`nate`, `oxy`) |

The last row of that table is the one that changes planning. The natural reading
of an empty pool is "the migration has not run yet". It has not, and it never
needs to: **there is no karma to migrate.** The pool is empty because no
reputation has been earned since the replacement — 62 transactions of a single
type in 38 days, none anywhere near the threshold of 100. Four documents in the
ecosystem declaring that migration pending are obsolete.

Two structural defects in V1 explain the mechanism:

- **Selection weight and vote weight are the same function.** `validatorWeight`
  feeds the selection reservoir and `stakeWeight` attaches the same value to the
  resulting vote. Nothing at either call site looks like a mistake; it looks like
  reuse. §8.4 requires the two to be separate, so replicating V1 inherits the
  defect.
- **`selectValidators` has no minimum-panel check.** It opens an
  under-sized panel and lets it expire rather than failing loudly. That is the
  observed behaviour above: not a prediction, a measurement.

And one defect that decides the shape of the axes rather than the eligibility
source: **`abuseScore` counts every negative transaction with weight 2**,
regardless of what the negative was for. A single `vouch_slashed` of −20 — nothing
to do with abusing the report system — contributes 2 against a denominator of
roughly 6, about a third of the way to a forced `restricted` tier. So in V1 a
moderation penalty would inflate the *report-abuse* score through a path that has
nothing to do with reporting.

## Decision

**Five axes, measured and stored separately, and never collapsed into one
figure.**

| Axis | What it measures | Why it cannot be merged with the others |
| --- | --- | --- |
| **Personhood** | How confident we are that this is one real, distinct person. | Being a real person proves neither good conduct nor competence. V1 makes personhood the *top* trust tier, which asserts both. |
| **Contribution** | Positive participation, points, tier. | Contribution must never neutralise a strike. §11.4's worked example is `contribution.points: 2000` alongside `conduct.standing: limited`, and in V1 that is unrepresentable: the strike is a negative `total` that contribution cancels. |
| **Conduct** | Standing, active risk, active strikes. | The consequence of a finding. Merging it with contribution is the specific defect above; merging it with reporting is the `abuseScore` defect above. |
| **Reporting** | Accuracy of reports filed, with smoothing and a confidence. | A wrong report is not misconduct. §11.11: `report_rejected` softly reduces an accuracy estimate and "no implica mala fe". Only `report_abuse_confirmed` is a conduct matter. |
| **Reviewing** | Reliability at judging, per category and per language. | Global reliability is not a usable signal. Someone excellent on spam and poor on harassment must not be counted reliable on a case alleging both. |

**And two weights that V1 conflates stay separate:** the weight that decides how
*often* a person is drawn, and the weight of a vote once they are on the panel —
which is one, always.

## Why CrowdSource has its own eligibility instead of inheriting Oxy's

Because the pool it would inherit is empty, and would still be empty after the
migration nobody needs to run.

§8.1–8.2 already describe the alternative: onboarding, training, calibration,
categories, languages, consent. CrowdSource implements that as its own source of
truth. `packages/backend/src/modules/reviewer/reviewer.collection.ts` states the
consequence in source — a reviewer profile carries **no reputation figure, no
karma and no Oxy `trustTier`**. A reviewer's standing in this service is their
state, their calibration and their per-category reliability, all of which
CrowdSource observes itself and can move a person through.

Oxy contributes an authenticated account and a verification flag, and no more.
`packages/backend/src/modules/reviewer/personhood.ts` records why: the obvious
implementation — require Oxy's `verified` flag — was measured against production
before it was written, and **the verified population is six accounts.** A gate six
people can pass is not a threshold, it is a closed product, and it is the same
failure mode as the empty `trusted` tier. So personhood is a score over several
independent signals (account active, Oxy verification, training completed,
calibration passed, sock-puppet suspicion), with the threshold as configuration
(`REVIEWER_MIN_PERSONHOOD_CONFIDENCE`) because the right value depends on how many
real reviewers exist, which changes.

A flagged account scores zero regardless of every other signal. An unverified
person who completed training and passed calibration reaches the default
threshold; one who did neither calibrates instead — which is what §8.2 describes.

## How the two weights are kept apart

Intention is not enough here, because V1 shows what merging them looks like from
the inside: reuse. So the separation is structural.

**Selection weight** lives in
`packages/backend/src/modules/sortition/selectionWeight.ts`, is imported by the
draw and by nothing else, and is never written onto an assignment or a review. The
candidate snapshot on the draw record carries it — that is the audit trail — and
the objects a vote is made of do not.

**Vote weight does not exist.** The consensus engine never sees a reviewer's
reliability, tier or selection weight.

Both halves are asserted:

- `packages/backend/src/__tests__/weightSeparation.test.ts` scans source to pin
  which modules may import the selection weight (today, the draw), and scans the
  assignment and review documents to assert they declare no weight-shaped field at
  all — so a consensus engine reading those rows has nothing to multiply by. It
  carries a mutation test and a vacuity floor, so a broken traversal cannot pass
  silently.
- `packages/backend/src/__tests__/consensusEngine.test.ts` holds the behavioural
  half: the same ballots cast by a panel of specialists and by a panel of
  newcomers reach a byte-identical verdict.

Reliability does reach two places, and both are legitimate under §8.4 and §9.5:
the draw turns it into one of four selection terms, and consensus averages it
across the panel into `panelQuality`, one of three terms in a **confidence
score** — which is a statement about how much to trust the decision, not a
multiplier on anybody's vote. `packages/backend/src/modules/reviewer/reliability.ts`
is the single shared definition so the two callers cannot disagree, and it takes a
profile and a list of families: no review, no outcome, no position. The number
cannot reach the count because the function that produces it has never been told
there is one.

One further detail worth recording rather than quietly correcting: §8.4's
coefficients sum to 0.30 against a base of 0.70, so the formula's range is
[0.70, 1.00] while the stated clamp is [0.75, 1.25]. **The upper bound is
unreachable.** The effective range is [0.75, 1.00], so the most favoured eligible
reviewer is drawn about 1.33× as often as the least favoured. It is implemented
verbatim: rescaling to reach 1.25 would invent a coefficient the plan does not
give, and it would move the answer in the wrong direction, since a wider spread
means reputation influences selection *more* and §8.4's whole instruction is that
the influence stays limited.

## The direction is one-way and structural

CrowdSource never writes an Oxy reputation collection. It emits an authenticated
internal event and Oxy Trust's own consequence engine decides the effect.

`packages/contracts/src/reputation-events.ts` is that event, and it is a
statement rather than an instruction: **nothing in it names points, a tier, a
strike or a standing.** Three of §11.7's eight pre-effect validations are moved
into the type so a refactor cannot drop them:

- `subject.bindingProofId` is required — "no binding proof, no Oxy Trust effect"
  becomes an event that cannot be constructed.
- A finding's scope must be `oxy_network` or `identity_integrity`;
  `application_local` cannot appear at all, which is §6.5's rule that a local
  restriction does not become a global sanction, enforced at the wire rather than
  by the receiver's diligence.
- The decision status enum holds only `provisional` and `final`, so a superseded
  or corrected decision cannot carry an effect.

This is the one payload in the contracts package that is strict in the *outbound*
direction, and it is the "except where the schema forbids them for safety"
exception in §10.11 twice over: a finding here carries no `resourceIds` and no
free text, so nothing about the reviewed material can reach a reputation ledger or
a signed attestation, and an unrecognised field is exactly how it would.
`packages/contracts/src/__tests__/reputation-events.test.ts` asserts that
`points`, `standing`, `strike`, `activeRisk` and `tier` are all rejected.

The privileged scope that a bridge would need,
`reputation:moderation:apply`, is in `PRIVILEGED_SCOPES` and therefore
unreachable through application credential issuance: `issueApplicationCredential`
**refuses** a privileged scope rather than filtering it out
(`packages/backend/src/modules/tenancy/provisioning.service.ts`), and
`packages/backend/src/__tests__/serviceCredential.integration.test.ts` asserts
both that refusal and that an unknown scope is refused rather than dropped.

## Consequences

1. A person can be highly contributing and simultaneously restricted, and the
   data model says so rather than netting it out.
2. A moderation conduct effect can never inflate a report-abuse score, because
   they are different axes rather than different signs of one number.
3. CrowdSource can seat a jury on the day it launches, because eligibility is
   something it grants, measures and revokes itself.
4. Any recovery of the V1 civic jury logic is a **replication of under 60 pure
   lines** — `hashUnit`, the weighted reservoir `u^(1/w)`, seed and candidate-snapshot
   persistence, the atomic claim on resolution, and affinity-pair
   canonicalisation — not an extraction. The rest is welded to binary civic votes
   and inherits the two defects above.
5. No design in CrowdSource may assume an IP-based exclusion signal. V1's IP
   exclusion was removed; what remains is `self | graph_neighbor | shared_device`.

## Gaps recorded by this ADR

- **The reputation bridge does not exist.** `packages/backend/src/app.ts` states
  it: "The reputation bridge is not written." The event contract is published; no
  module emits it and no route accepts it.
- **Only one of the five axes is measured in this repository today: reviewing.**
  The reviewer profile carries `reliabilityByCategory`, `personhoodConfidence`,
  `calibrationScore` and `completedReviewCount`. There is no reporting-accuracy
  figure anywhere — `reporterPriorityBoost` in
  `packages/backend/src/modules/triage/triage.ts` is an optional input that
  *nothing supplies*, precisely because Oxy Trust holds no reporter reliability
  yet — and conduct and contribution live in Oxy Trust, which has not been
  extended.
- **Reviewing reliability currently moves only at calibration.**
  `packages/backend/src/modules/reviewer/reviewer.service.ts` says so, and it is
  why the promotion volumes are not small: §9.7's other sources (gold cases in the
  live queue, appeal outcomes, audits) belong to phases that own the review and
  appeal flows and do not exist. Gold items are not injected into the live queue.
- **V1's live privacy leaks B1 and B2 were fixed** (`OxyHQServices` PR #716,
  merged 2026-07-28) but the remaining readiness blockers are open: `ReputationRule`
  still has no version field, so §11.8's "recalculate under the original policy"
  has no substrate; `reputation:write` still mixes ledger writes, jury opening and
  cross-tenant access and is already granted to every official app; and
  `ReputationBalance` is still one-dimensional. None of that is CrowdSource's to
  fix, and all of it gates emitting real effects.
- **§11.17's "authorized application → minimal contextual weights" surface does
  not exist.** A service credential receives `401` on every Oxy reputation route,
  which require a `sessionId`.
