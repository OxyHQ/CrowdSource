# Architecture

Architecture decision records, the threat model, and the module boundaries of the
backend's modular monolith.

| Document | Settles |
| --- | --- |
| [ADR 0001](0001-divergence-from-the-plan.md) | Where CrowdSource diverges from the plan's infrastructure, and what each divergence costs. |
| [ADR 0002](0002-the-universal-case-envelope.md) | One Case Envelope for every application, why resources and policies are versioned, and what the envelope refuses to carry. |
| [ADR 0003](0003-reputation-axes.md) | Why contribution, conduct, reporting, reviewing and personhood are separate axes and never one number. |
| [Threat model](threat-model.md) | PLAN §13.1 revised against what the system now is: each threat, its control, the file that implements it, and whether a test proves it. |

The plan's §15.1 also asked for an ADR of the service architecture itself — own
repository, modular monolith, Oxy Auth. It is not recorded separately because
nothing about it diverges from either the plan or the ecosystem, and `AGENTS.md`
already holds the module list and the `app.ts`/`server.ts` split such an ADR would
have restated.

Two rules govern anything added here. A document that describes behaviour the code
does not have is a bug — every document above marks absent controls as absent and
ends with a list of its gaps, for exactly that reason. And a claim that is
mechanically checkable should acquire a check: the repository already gates several
invariants with source-scanning tests (`collectionBoundary.test.ts`,
`decisionImmutability.test.ts`, `weightSeparation.test.ts`), each carrying a
mutation test and a vacuity floor so a broken traversal cannot pass silently.
