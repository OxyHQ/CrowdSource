# Reviewer API

The surface a reviewer's client talks to, authenticated by an **Oxy session**.
A service credential never satisfies any route here, and a reviewer's session
never satisfies an application-API route — see
[the four caller classes](./README.md#four-caller-classes-and-none-of-them-substitutes-for-another).

A reviewer carries **no tenant**. A juror is drawn across every application by
design, so there is nothing for a session to carry and nothing a caller could
name.

## What the shape of this API guarantees

Read the route table before the descriptions. **There is no case id anywhere in
it.** Every case-bearing route is addressed by *assignment*, and
`POST /v1/reviewer/assignments/next` takes no parameters at all — not a
category, not a filter, not a case id. "Nobody chooses the case they review" is
therefore a fact about the routing table rather than a rule somebody enforces,
and "a person who was not selected cannot open the case" is true by there being
nothing to ask (`modules/sortition/assignments.routes.ts`).

The history route follows the same shape: it pages through what *you* did and
has no parameter by which you could look for a particular case
(`modules/review/reviews.routes.ts`).

**Every refusal is `404`**, with the same message, whether the assignment does
not exist or is not yours. A `403` would confirm that the assignment exists —
which tells the asker that a case exists and that somebody was drawn for it.

## Session verification is unavailable when unconfigured

Session routes need `OXY_API_URL`, which has **no default** and which the
service boots without. A deployment that has not configured it answers `503`
naming the capability on every session surface, rather than accepting sessions
it cannot verify (`modules/identity/oxySession.ts`). The application API is
unaffected.

## Routes

| Method | Path |
| --- | --- |
| GET | `/v1/reviewer/profile` |
| POST | `/v1/reviewer/preferences` |
| GET | `/v1/reviewer/training` |
| POST | `/v1/reviewer/training/{moduleId}/complete` |
| POST | `/v1/reviewer/training/calibration` |
| POST | `/v1/reviewer/assignments/next` |
| GET | `/v1/reviewer/assignments/{assignmentId}` |
| POST | `/v1/reviewer/assignments/{assignmentId}/reviews` |
| POST | `/v1/reviewer/assignments/{assignmentId}/recuse` |
| GET | `/v1/reviewer/reviews` |

There is deliberately **no `POST /v1/reviewer/onboarding`**. Everything an
onboarding screen collects — languages, categories, sensitive-material consent,
age attestation, rules acceptance — is what `POST /v1/reviewer/preferences`
updates. A second endpoint writing the same fields would be a second place the
adult-attestation refusal has to be remembered.

## The assignment token

`POST /v1/reviewer/assignments/next` returns the package **plus a `token`**,
once. Only its hash is stored. Present it as `x-assignment-token`
(`ASSIGNMENT_TOKEN_HEADER` in `@oxyhq/crowdsource-contracts`) on the three
routes addressed by assignment id.

## `POST /v1/reviewer/assignments/next`

No body. `204` when nothing is assigned — the draw happened elsewhere, on the
case's own schedule, and this is the reviewer picking up what they were given.
`200` returns an `IssuedAssignmentPackage`: the `AssignmentPackage` plus
`token`.

### What the package shows, and what it withholds

The projection is a pure function in `modules/sortition/reviewPackage.ts`, so
what a reviewer can see is testable without a database, a draw and an HTTP
request.

**Shown:** the resources and the context needed to judge them; the allegation
codes **as unverified allegations**; the applicable policy and its rules;
language; warnings; sensitivity class.

**Withheld:** the number of reports; any reputation, anyone's; prior votes or
partial results of any kind; the identity of other jurors; the reporter's
identity; the reporter's free-text `details`; and the application's identity — a
reviewer who knows which product a case came from is a reviewer who knows its
brand.

On an appeal panel the package additionally carries the author's own
`authorContext`, labelled `unverified` exactly as an allegation is. It carries
nothing else about the appeal: not the reason code (an argument about the
verdict would anchor the reviewer), not the superseded decision, not the raised
threshold. A reviewer can tell the case is contested, because somebody is
contesting it in their own words; they cannot tell what anybody concluded.

Where a renderer is genuinely missing — video, audio and document resources
today — the reviewer is told plainly and `insufficient_context` and recusal stay
open (`packages/reviewer/components/review/ResourceView.tsx`).

## `POST /v1/reviewer/assignments/{id}/reviews`

Body: `ReviewSubmissionSchema`, strict.

```json
{ "outcome": "violation",
  "contextSufficiency": "sufficient",
  "findings": [{ "code": "harassment.targeted_abuse",
                 "resourceIds": ["res_subject"],
                 "severity": "medium",
                 "context": "satire",
                 "confidence": 0.8,
                 "policyRuleIds": ["crowdsource.baseline.harassment"] }],
  "recommendedActions": ["remove_or_restrict"],
  "notes": "…" }
```

A reviewer's `outcome` is one of four: `violation`, `no_violation`,
`insufficient_context`, `content_unavailable`. **`inconclusive` is not among
them** — a single reviewer cannot fail to agree with themselves, and "absence of
consensus is neither guilt nor innocence" only holds if `inconclusive` is
produced by the engine and never voted for.

Two rules the schema enforces: `insufficient_context` requires
`contextSufficiency: "insufficient"`, and `violation` requires at least one
finding.

The submission is **strict**, and that is a safety decision. If it tolerated a
`caseId`, an `assignmentId` or a `reviewerId`, the day somebody read one would
be the day a reviewer could vote on a case they were never drawn for.

`201` returns `{ reviewId, submittedAt }` and nothing else. No case id, no hint
of what anybody else concluded — "you were the third of three" is a partial
result.

## `POST /v1/reviewer/assignments/{id}/recuse`

```json
{ "reason": "too_sensitive", "note": "…" }
```

`reason` is one of `conflict_of_interest`, `language`, `too_sensitive`,
`insufficient_context`.

`204`, with an empty body. A recusal costs the reviewer nothing, and a body
reporting a new score, a warning or a count would be the first step toward it
costing something. A vacated seat is replaced under the *same* slot
specification, without lowering the threshold.

## `GET /v1/reviewer/profile`

Eligibility, categories and **private** reliability — private meaning shown to
its owner and to nobody else. The reviewer id comes from the session and is
never a parameter, so there is no route on which one reviewer could read or
change another's eligibility. What is shown and what is withheld is decided once
in `modules/reviewer/reviewerViews.ts`.

## `POST /v1/reviewer/training/calibration`

Returns the score and **which items were wrong, never which answer was right**.
A calibration that hands back the answer key is one everybody passes on the
second attempt, which measures attendance rather than judgement.

## Pending: nobody can sign in yet

The reviewer app is `packages/reviewer` (Expo Router, web at
`crowdsource.oxy.so`). Interactive sign-in needs `EXPO_PUBLIC_OXY_CLIENT_ID`,
which has **no default in source** (`packages/reviewer/config.ts:38`) because
hard-coding one would borrow another product's identity.

Status, verified rather than assumed:

- `.github/workflows/deploy-frontends.yml:85` supplies a client id to the
  reviewer's production build, so a deployed reviewer app has one.
- A local `bun run dev:reviewer` has none unless you export it, and interactive
  sign-in cannot start without it. Cold boot and anonymous surfaces are
  unaffected.
- Whether the Oxy application behind that id has `https://crowdsource.oxy.so`
  registered as a redirect surface is a fact about Oxy's identity layer, not
  about this repository, and is not verifiable from here.

Until a reviewer can sign in, the reviewer API is reachable only by a client
holding an Oxy session obtained elsewhere, and the production jury pool cannot
grow. A case that cannot empanel is covered in
[the runbook](../runbooks/case-cannot-empanel.md).
