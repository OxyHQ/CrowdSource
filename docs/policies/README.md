# Policies

For the people who judge cases, and for the people who write the rules those
judgements are measured against.

## Three layers, and they never merge

| Layer | Question | Owner |
| --- | --- | --- |
| 1 — classification | What does the material *contain or represent*? | CrowdSource's universal taxonomy |
| 2 — policy | Does that break *this application's* rules? | The tenant's versioned policy set |
| 3 — conduct | Should this conduct affect trust *across Oxy*? | The Oxy conduct policy |

Collapsing any two of them is what makes a moderation service unusable by a
second application. The same material is artistic nudity under one product's
rules and a violation under another's — and it is the same *classification* in
both cases. So a jury classifies once, and any number of applications evaluate
that classification against their own rules.

A reviewer works in layer 1 and touches layer 2 only by naming which rule they
think the classification triggers. **Layer 3 is not a reviewer's business at
all**, and nothing on a reviewer's screen mentions it.

Layer 3 has no engine yet. `OXY_CONDUCT_POLICY_VERSION` (`oxy.2026.1`) is
stamped on every decision so that when the reputation bridge exists it can tell
which conduct policy a historical decision was made under and refuse to
re-interpret it under a newer one. It is a label, not a promise that the bridge
exists — it does not.

---

## The universal taxonomy

Version `2026.1` (`UNIVERSAL_TAXONOMY_VERSION`). **39 codes in 11 families**,
and the list is **closed** — `packages/contracts/src/taxonomy.ts`. An open
string would let one tenant mint private codes, which is exactly the
cross-application comparability layer 1 exists to protect.

| Family | Codes |
| --- | --- |
| `integrity` | `spam`, `scam`, `fraud`, `impersonation`, `coordinated_manipulation` |
| `harassment` | `insult`, `targeted_abuse`, `sexual_harassment`, `doxxing`, `credible_threat` |
| `hate` | `dehumanization`, `slur`, `incitement`, `protected_targeting` |
| `violence` | `graphic`, `threat`, `instruction`, `celebration` |
| `sexual_content` | `nudity`, `explicit_activity`, `non_consensual`, `exploitation` |
| `child_safety` | `sexualization`, `grooming`, `exploitation` |
| `self_harm` | `promotion`, `instruction`, `imminent_risk` |
| `privacy` | `personal_information`, `intimate_media`, `location_exposure` |
| `commerce` | `prohibited_item`, `counterfeit`, `misleading_listing`, `unsafe_product` |
| `platform_abuse` | `ban_evasion`, `report_abuse`, `automation_abuse` |
| `other` | `policy_specific`, `unclassifiable` |

`other.unclassifiable` is not a shrug. A case landing there says the universal
taxonomy has no code for the material, which is a signal worth reading rather
than a default.

Note `platform_abuse.report_abuse`: **reporting is itself a capability that can
be weaponised**, and abusing it is classifiable like anything else.

Adding a code is additive and bumps the taxonomy version. Every decision records
the version it was classified under, so a historical decision keeps meaning what
it meant.

---

## What a reviewer is actually asked

The form has two steps, and the split exists to reduce anchoring on the
reporter's chosen category: **describe the material, then evaluate it against a
rule.** The submission (`ReviewSubmissionSchema` in
`@oxyhq/crowdsource-contracts`) carries both.

### Step one — findings

| Field | |
| --- | --- |
| `code` | One of the 39 above. |
| `resourceIds` | Which material this finding is about. Required, non-empty. |
| `severity` | `low` · `medium` · `high` · `critical` |
| `context` | Optional. The exception that changes what the classification means. |
| `confidence` | 0–1. Communicates quality and can trigger escalation. **It never weights the vote.** |
| `policyRuleIds` | Optional. Step two. |

`resourceIds` is required because agreement is measured on *which material is
implicated* — a finding that does not say what it is about cannot be agreed or
disagreed with.

`policyRuleIds` is optional because step one can complete without step two: a
reviewer may classify material accurately and find no rule that covers it. That
is the ordinary `no_violation`-with-findings case, not a mistake.

**The exception vocabulary is closed** (`FINDING_CONTEXTS`): `artistic`,
`educational`, `documentary`, `newsworthy`, `satire`, `counter_speech`,
`medical`, `consensual`, `fictional`. Absence means no exception applies, which
is the safe direction. It is closed for two reasons: two reviewers who both
answer `no_violation` for incompatible reasons have not agreed about the
material and free text could not tell them apart; and an open token would be a
channel for case content to reach a decision record.

Nudity with `context: artistic` is a *different description of the material*
from nudity — not a different verdict about it. That distinction is the whole
reason the field sits beside the code rather than beside the outcome.

### Step two — the verdict

`outcome` is one of **four**:

| | |
| --- | --- |
| `violation` | Requires at least one finding. |
| `no_violation` | |
| `insufficient_context` | Requires `contextSufficiency: "insufficient"`. |
| `content_unavailable` | The material could not be seen. |

**`inconclusive` is not a reviewer outcome.** A single reviewer cannot fail to
agree with themselves. It is produced by the consensus engine and never voted
for, which is what makes "absence of consensus is neither guilt nor innocence"
true rather than aspirational.

`recommendedActions` is a list of action tokens (`RECOMMENDED_ACTIONS`, 22 of
them, from `remove` and `suspend_user` through `label`, `age_gate` and
`no_action` to `specialist_queue` and `legal_queue`). A reviewer recommends a
course of action; consensus is what binds an agreed recommendation to the
specific resources it applies to.

### Stepping away costs nothing

A reviewer may recuse for `conflict_of_interest`, `language`, `too_sensitive` or
`insufficient_context`. The response is `204` with an empty body — no score, no
warning, no count — because a body reporting consequences would be the first
step toward it costing something. The vacated seat is refilled under the same
slot specification, without lowering the threshold.

---

## The baseline policy set

`crowdsource.baseline`, version `2026.07`
(`packages/backend/src/modules/policy/policyBaseline.ts`). It is what an
application is evaluated under before it has written a policy set of its own,
and it is what `DEFAULT_POLICY` in the SDK points at.

**One rule per taxonomy family**, tenant-neutral, each binding that family's
codes to a starting severity and the actions an application would typically
consider:

| Rule | Default severity | Typically |
| --- | --- | --- |
| `crowdsource.baseline.integrity` | `medium` | `remove_or_restrict`, `reduce_distribution`, `label` |
| `crowdsource.baseline.harassment` | `medium` | `remove_or_restrict`, `hide`, `suspend_user` |
| `crowdsource.baseline.hate` | `high` | `remove`, `suspend_user` |
| `crowdsource.baseline.violence` | `high` | `remove`, `age_gate`, `escalate` |
| `crowdsource.baseline.sexual_content` | `high` | `age_gate`, `remove_or_restrict`, `escalate` |
| `crowdsource.baseline.child_safety` | `critical` | `remove`, `legal_queue`, `suspend_user` |
| `crowdsource.baseline.self_harm` | `high` | `safety_queue`, `remove_or_restrict`, `escalate` |
| `crowdsource.baseline.privacy` | `high` | `remove`, `escalate` |
| `crowdsource.baseline.commerce` | `medium` | `remove_or_restrict`, `freeze_transaction`, `request_changes` |
| `crowdsource.baseline.platform_abuse` | `low` | `reduce_distribution`, `suspend_user`, `local_manual_review` |
| `crowdsource.baseline.other` | `low` | `local_manual_review`, `hold` |

**The severities are a starting classification of how much harm a family
typically represents. They are not a verdict, not a finding, and not visible to
a jury.** A jury classifies the material itself before any rule is consulted.

Three properties make a shipped baseline safe rather than a shortcut:

- **It is data.** A rule has an id, a title, the taxonomy codes it responds to, a
  default severity and recommended actions — and **no expression, predicate,
  script, template or callback field of any kind**. That absence is the control,
  and `PolicySetVersionSchema` is strict, so a policy set carrying an
  unrecognised key is rejected rather than accepted with the key quietly
  dropped.
- **It is versioned and frozen.** Editing a rule means publishing a *new*
  version constant, never modifying this one. It is parsed by the published
  contract at import time, so a malformed baseline fails at boot rather than at
  the first report that references it.
- **It never wins over a tenant's own.** The registry resolves a
  tenant-registered set first; this is the fallback for the one id/version pair
  it owns.

### Versioning is not future-proofing

It is what stops a decision being re-interpreted under rules it was not made
under. **Every decision is stamped with three policy versions** — taxonomy,
application policy set, Oxy conduct — and never fewer. "A policy update never
silently rewrites historical decisions" is unenforceable without a version on
every decision from the first one.

A default must therefore be a *pinned* version, never "whatever is current". A
resolved-at-ingress "latest" would move the policy under an application that
changed nothing, and would split the case dedup key — the policy version is part
of it — so one post would open two cases.

### Gap: a policy version cannot carry examples

`PolicySetVersionSchema` is a strict object with `policySetId`, `version`,
`status`, `title`, `locale`, `publishedAt` and `rules`; `PolicyRuleSchema` has
`id`, `title`, `description`, `taxonomyCodes`, `defaultSeverity` and
`recommendedActions`. **There is no field for worked examples**, positive or
negative, on either. A reviewer sees a rule's title and prose description and
nothing else, and a tenant that wants to show "this counts, this does not"
cannot express it. Closing the gap is an additive contract change plus the
reviewer surface to render it.

---

## Routing: what a community jury never sees

Triage computes a `sensitivityClass` and a `reviewPool` from the allegation
codes. It is a **table, not a model** — deterministic, auditable, identical on
every replay (`packages/backend/src/modules/triage/triage.ts`). The strictest
allegation in a case wins.

| Class | Pool | Codes |
| --- | --- | --- |
| `prohibited` | `legal` | all three `child_safety.*` |
| `restricted` | `specialist` | `self_harm.imminent_risk`, `harassment.credible_threat`, `violence.threat`, `sexual_content.non_consensual`, `sexual_content.exploitation`, `privacy.intimate_media` |
| `sensitive` | `specialist` | `violence.graphic` |
| `sensitive` | `community` | `privacy.personal_information`, `privacy.location_exposure`, `harassment.doxxing`, `sexual_content.nudity`, `sexual_content.explicit_activity`, `self_harm.promotion`, `self_harm.instruction` |
| `standard` | `community` | everything else |

**The tenant's `sensitivityHint` is not consulted for routing.** The computed
class is the authority, so an application that under-declares cannot talk its
way into a community jury. Nor can it opt in: an envelope alleging child safety
or non-consensual sexual material with `allowCommunityReview: true` is
**refused**, not quietly corrected — the belief that this material can be
community-reviewed is the defect, and silently fixing the field would leave the
belief in place.

Several of those rows also carry a redaction flag, and the `prohibited` and
`restricted` rows escalate out of the ordinary queue entirely.

Triage decides the order cases are reviewed in, the pool required, and whether
the material may be shown to the community. **It does not decide guilt**, and
none of its inputs — report count, velocity, reporter signals — is ever shown to
a jury.

---

## How a panel reaches a decision

A reviewer does not need the arithmetic, but does need to know **why unanimity
is sometimes not enough**, because that is the surprising part.

**Consensus is not a vote count.** Agreement is measured on **six dimensions at
once**, as one key: outcome, taxonomic family, affected resources, severity,
context sufficiency, and the exception. Four reviewers who all answer
`violation` while disagreeing about what they found have not agreed on anything
a decision could state — one thinks it is harassment at medium severity, another
a privacy breach on a different resource — and publishing "violation, 4 of 5"
over that would be inventing a finding no juror made. There is nowhere to add a
"close enough" without deleting a dimension, which is a visible edit.

Agreeing votes required: the larger of the round's ladder and the risk floor.

| Round | Ladder | | Risk | Floor |
| --- | --- | --- | --- | --- |
| 1 | 3 of 3 | | `low` | 3 |
| 2 | 4 of 5 | | `medium` | 4 |
| 3 | 5 of 7 | | `high` | 5 |
| | | | `critical` | never by a standard community jury |

Risk comes straight from the sensitivity class triage already computed —
`standard`→`low`, `sensitive`→`medium`, `restricted`→`high`,
`prohibited`→`critical`. **So a medium-risk case with three unanimous reviews
expands rather than publishing.** That is deliberate: the risk floor is a
minimum, and a ladder rung below the floor does not decide.

Structural requirements gate the decision independently of the count: a
medium-risk panel needs a trusted reviewer on it; a high-risk panel needs a
specialist **and** no critical conflict between findings. A panel that reaches
five of seven and never had a specialist does not decide — that is the
difference between "the jury agreed" and "the jury the rules asked for agreed".

The engine never sees a reviewer's reliability, tier or selection weight, and
has no parameter it could receive one through. Confidence is computed **after** a
verdict, from the verdict. A high-quality panel and a low-quality one that cast
identical ballots reach the identical outcome and differ only in the number
attached to it. **One qualified person, one vote** — reputation affects who is
drawn, never how much a vote counts.

## Decision outcomes

Seven, and an application must handle all of them:

`violation` · `no_violation` · `insufficient_context` · `inconclusive` ·
`content_unavailable` · `duplicate` · `escalated`

Three are appealable — `violation`, `inconclusive`, `insufficient_context` —
because those are the ones with a consequence the subject can be owed a second
look at. The reasoning for each inclusion and each exclusion is in
[the appeals ADR](../architecture/appeals.md).

**A published decision is never edited, only superseded.** An appeal creates a
new revision; the superseded one keeps its id and its content forever.
