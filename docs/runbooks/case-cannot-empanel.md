# A case cannot empanel

Cases are being created and no jury sits on them. This is the failure that
matters most and the one most likely to be silent, so it is recorded rather than
inferred.

## First: a refusal is not an error

When the pool cannot fill a panel, `openPanel` **records a refused draw and
returns normally**. The outbox event is marked dispatched rather than retried
eight times into a dead letter, because the pool being too small is a *state of
the world*, not a transient error — and retrying it on a backoff would bury the
one row you need under seven identical ones.

So: **do not look in the outbox for this.** Look in `sortition_draws`. The case
keeps its status and is drawn again when something changes.

## 1. Read the refused draws

Every draw — successful or refused — is a durable row in `sortition_draws`, with
an index on `{ status, drawnAt }` for exactly this question.

```js
db.sortition_draws.find({ status: "refused" }).sort({ drawnAt: -1 }).limit(50)
```

Each row carries the seed, the candidate snapshot, the rejections with their
reasons, the requested slots, `sampledCount`, `eligibleCount`, the panel spec,
and `rulesVersion`. Give an auditor one of these rows and they can re-run the
draw and get the same panel. That is the point of writing the record **before**
the assignments, in the same transaction: a draw whose seed was written
afterwards could have been re-rolled until it came out well.

The system this replaces recorded nothing at all, leaving twenty expired
requests as the only evidence.

## 2. Read `refusalReason`

| Reason | Means |
| --- | --- |
| `candidate_pool_too_small` | Fewer eligible reviewers than the panel needs. |
| `slot_unfillable` | A specific seat could not be filled — no candidate matched it or its fallbacks. |
| `reliability_minimum` | Enough bodies, not enough reliable ones for the spec's `minReliableCount`. |
| `legal_pool` | **Not a failure.** See below. |

**`legal_pool` is correct behaviour.** Material routed to the legal pool is
never delivered to a jury; it waits for a specialist team under legal protocol.
It is recorded as a refused draw rather than silently skipped, because "no panel
was ever opened for this case" and "this case is waiting for a specialist team"
look identical from the outside otherwise, and only one of them is correct. Do
not try to fix these.

## 3. Read the rejections

`rejections[]` names each candidate the pool contained and the rule that removed
them. The reason is either an eligibility rejection or an exclusion, and the two
call for opposite responses.

**Eligibility** (`ELIGIBILITY_REJECTIONS`) — the reviewer is not currently
drawable:

`account_inactive` · `state_not_drawable` · `suspended` · `unavailable` ·
`personhood_below_threshold` · `rules_not_accepted` · `calibration_expired` ·
`category_not_accepted` · `language_mismatch` · `sensitivity_above_consent` ·
`category_consent_missing` · `adult_attestation_missing` · `sock_puppet_signal` ·
`daily_limit_reached` · `open_assignment_limit` · `sensitive_exposure_rest`

**Exclusion** (`EXCLUSION_REASONS`) — the reviewer must not judge *this* case:

`subject_principal` · `reporter` · `prior_juror` · `declared_relation` ·
`application_conflict` · `party_risk_cluster`

A pile of `daily_limit_reached` or `open_assignment_limit` means the pool is
working and too small. A pile of `category_consent_missing` or `language_mismatch`
means the pool is large enough and wrong-shaped for these cases. A pile of
`calibration_expired` means an onboarding problem, not a supply problem.
**Never widen an exclusion to fill a seat** — those are the conflict rules, and
lowering them is worse than an unfilled panel.

## 4. Which seat could not be filled

Panel specs are in `modules/sortition/panelSpec.ts`. The community ladder is
3 seats at round 1, 5 at round 2, 7 at round 3; the specialist ladder is
3 / 5 / 7 seats all of type `category_specialist`. Appeals open at round 2 with
at least five seats.

Slots fall back, except where falling back would defeat the routing:

| Slot | Falls back to |
| --- | --- |
| `reliable_general` | itself only |
| `category_specialist` | `reliable_general` |
| `intermediate` | `reliable_general` |
| `calibrated_newcomer` | `intermediate`, `reliable_general` |
| `appeals_reviewer` | `reliable_general` |

**The specialist ladder does not consult the fallback chain at all.** A case
reached that pool because of what the material is alleged to be, and "no
specialist was available, so a general reviewer saw it" is precisely the failure
the routing exists to prevent. It surfaces as a refusal an operator sees rather
than as a quietly downgraded panel. If specialist cases are refusing, the answer
is more specialists in that family, never a wider fallback.

## 5. The sample window

One draw samples up to `SORTITION_CANDIDATE_SAMPLE_SIZE` profiles (default 400)
from a random point on a uniform sampling key, wrapping around zero. The cost is
bounded by the sample size, not by the population, and it is at most two queries.

`sampledCount` on the draw tells you how many the index actually returned. **If
`sampledCount` is much smaller than the configured sample size, the eligible
population itself is smaller than the window** — the filter, not the sample
size, is what is short. Raising `SORTITION_CANDIDATE_SAMPLE_SIZE` will not help;
it buys a more representative pool per draw when there is a population to be
representative of.

## 6. Nothing is refusing, and cases still have no panel

Then the draw is not being *asked for*. Check, in order:

1. `case.ready_for_review` rows in `outbox_events` — if they are `pending`, this
   is an [outbox problem](./outbox-backlog.md), not a sortition problem.
2. `assignment.vacated` rows — a recusal or expiry publishes one, and the
   replacement is drawn from it. A backlog here leaves panels one member short
   of their own threshold.
3. Whether a panel already exists for the **current revision**. The replay guard
   queries assignments scoped to `stored.currentRevision`; an appeal that opened
   revision 2 needs a new jury, and revision-1 assignments do not satisfy it.

## The state of the pool today

**No reviewer can currently sign in**, so the production jury pool cannot grow
through the intended path.

Verified rather than assumed: `EXPO_PUBLIC_OXY_CLIENT_ID` has no default in
source (`packages/reviewer/config.ts:38`), and interactive sign-in cannot start
without one. The production build supplies a client id
(`.github/workflows/deploy-frontends.yml:85`); whether the Oxy application
behind it has `https://crowdsource.oxy.so` registered as a redirect surface is a
fact about Oxy's identity layer and not verifiable from this repository. A local
`bun run dev:reviewer` has no client id at all unless you export one.

While that holds, expect `candidate_pool_too_small` on essentially every draw,
and read it as the known cause rather than as a new incident. A reviewer profile
is created on first sight of a verified Oxy session, in the `applicant` state —
which is not drawable — so a person must sign in **and** complete training and
calibration before they can be drawn at all.

## What is deliberately not available

- **There is no way to assign a case to a chosen reviewer**, for any caller
  class. Nobody chooses the case they review, and nobody chooses the reviewer
  either. There is no route, no console action and no field.
- **There is no threshold override.** A replacement is drawn under the same slot
  specification as the seat it fills, because lowering a threshold to fill a
  vacancy is the one thing a replacement must never do.
- **`reviewPool` is written only by triage**, and nothing re-routes a case
  afterwards. A decision of `escalated` hands `specialist_queue` or
  `legal_queue` to the *application* as a recommended action; it does not move
  the case. Doing that automatically would draw panels from pools that may be
  empty with nobody accountable for it.
