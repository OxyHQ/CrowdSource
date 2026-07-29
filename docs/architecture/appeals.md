# ADR: appeals — the choices §9.8 left open

**Status:** accepted, implemented (phase 8, §15.9).
**Scope:** `packages/backend/src/modules/appeals`, the appeal rungs in
`sortition/panelSpec.ts`, `AppealStandard` in `consensus/consensus.ts`, and
`appeals.ts` in `@oxyhq/crowdsource-contracts`.

§9.8 states six rules for an appeal — a new jury, blindness, additional context,
provisional effect, correction, audit — and leaves the questions an
implementation cannot avoid unanswered. This records the answer chosen for each,
why, and what would justify changing it. It is here rather than in a commit
message because a choice nobody can find is a choice the next person re-makes
differently.

Every claim in the fenced block at the end is asserted against the code by
`src/__tests__/appealsAdr.test.ts`. Editing a number here without editing the
code fails the build, and vice versa.

## 1. Which decisions are appealable

§9.8: "toda decisión con consecuencias relevantes debe ser apelable." It never
says which outcomes have relevant consequences.

**Chosen:** `violation`, `inconclusive`, `insufficient_context` — read off
§7.6's table of what an application may DO with each outcome.

- `violation` — removal, restriction, suspension. The case §9.8 is written for.
- `inconclusive` — §7.6 permits `keep_restricted_temporarily`, so a restriction
  can outlive a jury that agreed on nothing. §9.6 is explicit that this is not
  innocence, so the author is owed a way to contest it.
- `insufficient_context` — §7.6's `hold` and `request_more_context`. The one
  case where §9.8's remedy *is* the remedy: the author supplies what nobody had.

Excluded, each for its own reason: `no_violation` (decided in the author's
favour; opening a revision would put them back in front of a jury they already
won in front of), `duplicate` (argue with the case it merged into),
`content_unavailable` (a new jury cannot conjure evidence; a fresh report can),
`escalated` (a process that has not finished — appealing a referral would ask a
community panel to pre-empt the specialist path §7.5 routed it to).

**Would change this:** a §7.6 revision that gives one of the excluded outcomes a
consequence for the subject.

## 2. Who may file

§9.8 says "el autor". CrowdSource never sees an application's users, so it
cannot authenticate one.

**Chosen:** the application files on the author's behalf over the application
API (`POST /v1/cases/{id}/appeals`, scope `crowdsource:appeals:write`), and the
`appellantExternalPrincipalId` must appear in the case's
`contentSnapshot.principals` — the principals the reported MATERIAL points at.

That set is what makes the rule enforceable rather than declarative: a reporter
is referenced by an allegation and never by the material (see
`evidence/contentSnapshot.ts`, where reporters are excluded from the snapshot so
two reports of one post still merge), so a reporter's id is not in it and cannot
appeal a decision that went against somebody else. Neither can an unrelated
account the application happens to know about.

**Rejected:** authenticating the subject directly. It would require CrowdSource
to hold an identity for every user of every tenant — the opposite of §13.5's
minimisation and of the near-zero-configuration integration the product is
built on.

## 3. What "additional context" may contain

§9.8: "una explicación o evidencia estructurada, sujeta a validación y
redacción." It does not say what structured evidence is.

**Chosen:** a free-text `statement`, `resourceIds` pointing at resources
**already in the case snapshot**, and a flat scalar `fields` bag. No URLs, no
blobs, no nesting.

New media evidence enters through §10.2's upload endpoints, where it is hashed
and its type checked. Those do not exist yet (phase 2), so today an appeal can
re-point at material the jury already has and argue about it. A URL here would
be an unvalidated resource on a reviewer's screen (§7.2.7) and worse — see the
next section.

## 4. What redaction means for text the subject of a case wrote

§9.8 requires redaction and does not say of what. This is the only inbound text
in the system written by the person being judged, addressed to the people
judging them.

**Chosen** (`appeals/appealContext.ts`, applied once at ingress so the raw bytes
are never stored):

- **URLs are removed**, and this is the rule that matters most. A juror who
  opens an author-supplied link tells the person under review their IP, their
  rough location, and that their case is being read right now. §9.1 keeps juror
  identity from everybody and §13.8 asks for pseudonymous short-lived access;
  a live link from the author defeats both, and no care in the client fixes it.
- **Bidi overrides and zero-width characters are stripped**, because a stored
  string that displays as something other than what it says is how a statement
  claims a sentence it does not contain.
- **Contact details, identifier-shaped numbers and credential-shaped strings are
  masked** (§7.5 row 4, §13.4, §13.5). The digit rule counts DIGITS, not
  characters, so `2026-07-01` survives — a date an author cites is their
  defence, not a leak.
- **The hostile text itself survives.** An author defending a post that quoted a
  threat has to be able to quote it back. The boundary is structural and never
  lexical; a filter that refused the sentence would refuse the defence.

The reviewer's package labels it `unverified`, exactly as an allegation is
labelled, and carries nothing else about the appeal — not the reason code (an
argument about the verdict would anchor the reviewer against §9.1), not the
superseded decision, not the raised threshold.

## 5. How much higher the appeal threshold is

§9.4's appeal row: "jurado nuevo, mínimo 5, umbral superior al de la primera
decisión cuando la acción sea grave." Neither "mínimo 5" nor "grave" is defined
operationally, and "superior" gives no amount.

**Chosen:**

- **Minimum five is a ladder rung, not a check.** Every revision past the first
  opens on an appeal ladder whose lowest rung is five seats, so no path —
  initial draw, replacement, expansion, replayed event — can produce a panel of
  three for an appeal. There is no round-1 appeal specification at all; asking
  for one throws.
- **Severe** = the decision recommended taking the material away, cutting its
  reach, or acting on the person; **or** made a `high`/`critical` finding;
  **or** made a finding whose scope may reach Oxy Trust (§11.7.5's
  `oxy_network`, `identity_integrity`). The second two are in because §9.8's
  correction has to reverse a conduct effect: a decision that asked only for a
  label while making a network-wide finding has still done something severe.
  `label`, `allow_with_label` and `age_gate` are deliberately not severe — the
  condition has to be able to be false, or §9.4's sentence describes nothing.
- **Superior = one more vote**, capped at unanimity of the appeal panel. The cap
  is not softening: without it a chain of appeals eventually asks for eight
  votes of seven, a threshold no panel can reach, and every such case would end
  `inconclusive` forever while the code reported that it was applying a rule.
- The bar is resolved when the appeal is FILED and stored on it, so it is
  auditable and cannot drift when a ladder is next edited. The engine takes the
  larger of it and the ordinary requirement, so an appeal standard can only ever
  raise.

## 6. Whether an Appeals Reviewer is required

§8.1: an appeals reviewer "puede participar en jurados de apelación". §9.4's
appeal row asks only for a new jury of at least five.

**Chosen:** a preference with a fallback, not a requirement. The community
appeal ladder seats one `appeals_reviewer`, which falls back to
`reliable_general` — the same reliability floor, one rung down in state.

Reading §8.1 as mandatory would mean no appeal could be empanelled until the
population contains appeals reviewers. That is the closed door that left Oxy
Trust's civic validator with an eligible pool of five people and twenty of
twenty-one validation requests expired without a single vote, and **an appeal
that never empanels is worse than one that errors**, because the author has been
told their case is being looked at again.

**The specialist appeal ladder has no such seat**, and the asymmetry is the
point: §7.5 routed that material to specialists because of what it is alleged to
be, and an appeals reviewer who is not a specialist in the family would be
exactly the general reviewer §7.5 says must never see it. Experience does not
substitute for consent plus competence.

## Deliberately not decided here

- **No appeal deadline.** §9.8 states none and the contract has no such field.
  It interacts with §13.6 retention — a window longer than a case's retention is
  a window that outlives the evidence — so it needs the retention work, not a
  number invented now.
- **No automatic re-pooling of an `escalated` decision.** Consensus can publish
  `escalated`, and `reviewPool` is written only by triage; nothing re-routes the
  case to the specialist pool afterwards. §7.6 hands `specialist_queue` /
  `legal_queue` to the application as a recommended action, and §9.6's "requires
  specialists, Trust and Safety or an external process" needs §4.3's Trust &
  Safety console to decide which. Doing it automatically would draw panels from
  pools that may be empty and would move a case's lifecycle with nobody
  accountable for it.
- **No per-reviewer overturn rate.** The per-case, per-category and
  per-application rate is derivable from the appeal rows and the decisions; the
  per-REVIEWER rate is the figure §9.7 constrains ("no castigar automáticamente
  a una minoría"), and today nothing writes a reliability figure from an appeal
  outcome — the only writer of `reliabilityByCategory` is calibration. Whatever
  computes an overturn rate must keep that true.

## Machine-checked claims

```adr-claims
appealable-outcomes: violation, inconclusive, insufficient_context
appeal-min-round: 2
appeal-panel-seats: 5
community-appeal-slots: appeals_reviewer, reliable_general, reliable_general, category_specialist, intermediate
specialist-appeal-slots: category_specialist
appeals-reviewer-fallback: appeals_reviewer, reliable_general
severe-actions: freeze_transaction, hide, keep_restricted_temporarily, reduce_distribution, remove, remove_or_restrict, suspend_user
```
