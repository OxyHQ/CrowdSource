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
| [`architecture/`](./architecture/README.md) | Decision records. [`appeals.md`](./architecture/appeals.md) is here; the divergence, case-envelope and reputation-axes ADRs and the threat model are written and unmerged on `docs/adrs-threat-model`. |

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
| `packages/backend/src/__tests__/docsClaims.test.ts` | The route tables in `api/`, parsed from the visible markdown, against every route the backend mounts **and the caller class each is mounted behind**; plus the fenced `docs-claims` blocks in the integration guide, the API reference, the policy document and the runbooks. |
| `packages/backend/src/__tests__/appealsAdr.test.ts` | The appeals ADR's `adr-claims` block, and that it still answers each question the specification left open. |

The route gate is the one worth understanding. It parses the tables a human
reads rather than a duplicate of them, so a route added to the wrong router — or
documented on the wrong page — fails by name. A service credential must never
satisfy a session route and vice versa, and that is the property it enforces.
