# ADR: community notes

**Status:** accepted, implemented.
**Scope:** `packages/backend/src/modules/communityNotes`, `community-notes.ts` in
  `@crowdsource.you/contracts`, and `docs/api/application.md#community-notes`.
Every claim in the fenced block at the end is asserted against the code by
`src/__tests__/communityNotesAdr.test.ts`.

## Context

An application asked for community notes: context that readers write under a
post, shown to everyone once enough raters agree it is helpful — the mechanism X
and Meta call Community Notes. The plan does not specify it. It is added here
because every hard part of it is a CrowdSource problem, not an application one:
who may take part, keeping writers and raters anonymous, resisting a coordinated
group, and making the "shown" outcome explainable and reversible. An application
that built it would rebuild half of this service.

It is a SEPARATE mechanism from moderation, and the separation is load-bearing.
A note removes nothing, restricts nothing and penalises nobody: it adds context.
It never opens a case, never feeds a decision, never produces a reputation
effect, and a case never produces a note.

## 1. Who writes and rates

CrowdSource has no relationship with an application's users (see the appeals ADR, §2).

**Chosen:** the application acts on its users' behalf over the application API,
naming each person by its own opaque `externalPrincipalId`, exactly as it files
reports and appeals. Eligibility beyond that (account age, verification) is the
application's call; CrowdSource enforces what only it can see across the whole
tenant: a writer is never handed their own note to rate, the author of a subject
is never handed a note on it, and a writer is capped at five notes a day.

## 2. Nobody chooses the note they rate

The moderation invariant "nobody chooses the case they review" exists because
choosing is how a group coordinates. A notes system with a free "rate this note"
button next to every note is exactly that door: a group shares a link and rates
together.

**Chosen:** a rating is accepted ONLY against a server-issued assignment.
`POST /v1/community-notes/assignments` draws, for one rater, a bounded random set
of notes that still need ratings, in the rater's languages, excluding their own
notes and notes on their own posts. Assignments expire. Reading a shown note
under a post grants no right to rate it.

**Rejected:** rating from the note under the post. It is the convenient surface
and the one a coordinated group would use.

## 3. "One qualified person, one vote" and the bridging model

That invariant is about juries: reputation must never weigh a vote. Notes are
not juries, but the spirit applies and is kept: every rating enters the model
exactly once, and no reputation, trust tier or account property scales it.

What the model does instead is estimate each rater's *viewpoint* from the ratings
they have given, and show a note only when raters of DIFFERENT viewpoints agree
it is helpful. That is not a weight on the vote; it is the question the note has
to answer. A note one faction loves and the other hates is, by design, not shown.

## 4. The scoring model

Matrix factorisation over the tenant's ratings, the published Community Notes
formulation:

    rating(u, n) ≈ μ + i_u + i_n + f_u · f_n

`helpful` = 1, `not_helpful` = 0. Fitted by gradient descent minimising squared
error plus `λ_i·(μ² + i_u² + i_n²) + λ_f·(f_u² + f_n²)`.

A note's status:

- `shown` when it has at least `MIN_RATINGS` ratings, `i_n ≥ SHOWN_INTERCEPT`
  and `|f_n| < MAX_FACTOR`;
- `not_shown` when it has at least `MIN_RATINGS` ratings and
  `i_n ≤ NOT_SHOWN_INTERCEPT − NOT_SHOWN_SLOPE·|f_n|`;
- `needs_ratings` otherwise.

Deterministic (fixed initialisation, fixed iteration count), so the same ratings
always produce the same statuses and any status can be recomputed and explained.

Every rating triggers a rescore of the whole tenant through the outbox
(`community_note.rated`), because a factorisation fitted over all ratings can
move a note the new rating never touched.

The algorithm carries a version. A status is recorded as an append-only revision
with the version and the fitted `i_n`, `f_n` it came from — never edited, only
superseded, like a decision.

## 5. Writing is capped, and a note is never rewritten

One note per writer per subject, five per writer per rolling day. A second note
by the same writer on the same subject is refused rather than replacing the
first: raters rated the words that are there, and rewriting them would carry
those ratings over to text nobody rated. The writer can withdraw a note, which
is final and removes its ratings from the model.

## 6. Anonymity

Writer and rater ids are stored (self-exclusion, caps and "your notes" need them)
and never leave CrowdSource except back to the SAME tenant that supplied them, on
the lists scoped to that principal ("notes you wrote", "notes you rated"). The
public lookup (`shown` notes for a set of subjects) carries no principal at all.
Audit rows record that a note was written or rated and by which credential —
never the text, never the principal.

## 7. What the application receives

- A batch lookup of the shown note per subject, cheap enough for a feed page.
- The writer's and rater's own lists.
- A webhook, `community_note.status_changed`, carrying the note id, subject id,
  the new status and the writer's `externalPrincipalId` — the application filed
  the note, so it already holds that id, and it needs it to tell the writer their
  note is now shown.

## Gaps

- No rater-helpfulness filter yet (the published model discounts raters whose
  past ratings disagreed with final outcomes).
- Eligibility is the application's; there is no Oxy Trust axis for notes.
- Raters are not capped: an application that creates accounts freely can flood
  the model with coordinated raters. The assignment door stops a group choosing
  which note they rate, not a group existing.
- A rescore refits the whole tenant on every rating. Fine at today's volume; a
  large tenant will need batching or an incremental fit.
- With few raters a tenant rarely reaches `MIN_RATINGS` with viewpoint spread, so
  few notes are shown. That is the model working, not failing.

## Machine-checked claims

```adr-claims
scoring-algorithm-version: mf-1
min-ratings: 5
shown-intercept: 0.4
max-factor: 0.5
not-shown-intercept: -0.05
not-shown-slope: 0.8
notes-per-author-per-day: 5
assignment-ttl-hours: 24
assignment-batch-max: 10
note-text-max-length: 500
note-statuses: needs_ratings, shown, not_shown, withdrawn
```
