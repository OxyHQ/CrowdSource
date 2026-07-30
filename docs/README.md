# CrowdSource documentation

CrowdSource is multi-tenant participatory moderation infrastructure: an
application sends a universal report, a randomly drawn jury reviews it blind, a
consensus engine publishes a versioned decision, and a webhook returns that
decision to the application.

**Start here:** [`integration.md`](./integration.md) — your first report and your
first decision, in five steps.

| | |
| --- | --- |
| [`integration.md`](./integration.md) | Send a report, receive a decision. One environment variable and the object being reported. |
| [`api/`](./api/README.md) | The HTTP contracts, organised by the four caller classes: application service credentials, reviewer sessions, developer-console sessions, Trust & Safety staff sessions. |
| [`policies/`](./policies/README.md) | The universal taxonomy, the baseline policy set, and what a jury is actually asked. For the people who judge cases. |
| [`runbooks/`](./runbooks/README.md) | Dead letters, outbox backlogs, cases that cannot empanel, and the two audit trails. |
| [`architecture/`](./architecture/README.md) | Decision records and the threat model: why CrowdSource diverges from the plan's infrastructure, the universal case envelope, the reputation axes, and appeals. |

## Three rules keep this tree honest

- **A document that describes behaviour the code does not have is a bug.** Write
  the document when the behaviour lands, not before.
- **State an absence as an absence.** A documented protection that does not exist
  is worse than an acknowledged gap, because the next person stops looking. Every
  document here names what its subject cannot do, and marks pending things as
  pending.
- **Anything load-bearing enough to be relied on gets a test that fails when it
  drifts.** Package `files` lists exclude `docs/`, so no consumer ever trips over
  a stale claim here to force a correction — nothing else will catch it.

Two gates implement the third rule, each with a mutation test proving it catches
the drift it claims to and a vacuity floor so a broken traversal cannot pass
silently:

| Gate | Checks |
| --- | --- |
| `packages/backend/src/__tests__/docsClaims.test.ts` | The route tables in `api/`, parsed from the visible markdown, against every route the backend mounts **and the caller class each is mounted behind**; the "what is not served" list, as patterns no served route may match; and the fenced `docs-claims` blocks in the integration guide, the API reference, the policy document and the runbooks. |
| `packages/backend/src/__tests__/appealsAdr.test.ts` | The appeals ADR's `adr-claims` block, and that it still answers each question the specification left open. |

The route gate is the one worth understanding. It parses the tables a human
reads rather than a duplicate of them, so a route added to the wrong router — or
documented on the wrong page — fails by name. A service credential must never
satisfy a session route and vice versa, and that is the property it enforces.

It also gates the **absences**, because that is where this tree has already gone
wrong once: a served/not-served list written from prose rather than from
`app.ts` named three capabilities as unserved when all three existed. A reader
believes an absence and either rebuilds what is already there or stops looking
for what is genuinely missing — and a *removed* capability and an *unbuilt* one
look identical in a list while calling for opposite responses. So each bullet in
[`api/README.md`](./api/README.md#what-is-not-served) says which it is and is a
pattern no served route may match.
