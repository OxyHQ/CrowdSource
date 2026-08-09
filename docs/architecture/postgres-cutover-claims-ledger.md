# Claims ledger — what the Postgres cutover has to correct

Every statement here is **true today** and stops being true when the backend
service moves to PostgreSQL. It is written before the port rather than after so
each claim is corrected in the change that falsifies it, instead of surviving it.

That is not hypothetical. In the Oxy repos that finished this migration, the
source-level "no Mongo" guards all passed while the prose stayed wrong for
months: oxy-api had a comment describing a Mongo recompute that had flowed into
its published `openapi.json`; Syra's always-loaded `AGENTS.md` was still telling
agents to use a helper deleted three domains earlier; Homiio's onboarding guide
had contributors install MongoDB against a backend that exits without
`DATABASE_URL`. Comments and markdown are exempt from those guards deliberately
and correctly — a ledger is what covers them instead.

**Scope note, because the repository is already split.** `@oxyhq/crowdsource-app`
(`packages/app`) ALREADY ships both stores — `src/mongoose/` and `src/postgres/`
— since #79, and `AGENTS.md` is current on that. This ledger is about
`@crowdsource/backend` (`packages/backend`), the ECS service, which is still
Mongo-only: task definition `oxy-crowdsource:26` carries `MONGODB_URI` and no
`DATABASE_URL`, and `package.json` declares `mongoose`.

---

## 1. ADR 0001's table is the primary artefact, and the port REVERSES it

`docs/architecture/0001-divergence-from-the-plan.md` already records exactly the
claims that move, as "plan says / CrowdSource does". Three of its six rows are
divergences the cutover **resolves** — the implementation converges back onto
`.plan/PLAN.md` rather than away from it:

| Plan § | Plan says | CrowdSource does today | After the cutover |
|---|---|---|---|
| 12.3 | RDS PostgreSQL as system of record | MongoDB + Mongoose | **plan is met** |
| 12.7 | PostgreSQL Row Level Security | code discipline — the access layer forces the tenant filter | **plan is met** |
| 12.7 | relational unique constraints | unique compound indexes | **plan is met** |

The other three rows (SQS→BullMQ, S3+KMS→`cloud.oxy.so`, three environments→one)
are untouched by the cutover and stay.

ADR 0001 is `Status: accepted` and supersedes nothing. It should be **superseded
by the cutover's own ADR**, not edited in place — its value is the record of why
the divergence was taken and what it cost, and that history stays true even once
the divergence ends. In particular its §1 "what it costs" analysis becomes the
argument for why the cutover was worth doing.

## 2. `AGENTS.md` — the always-loaded file, correct these first

| Claim | Heading |
|---|---|
| "**MongoDB is the system of record**" | `### Persistence` |
| `databaseIdentity.ts` and the `dbName`-override hazard, plus the four files that move together | `### Persistence` |
| "Postgres would have made isolation a property of the database. Mongo does not, so **isolation is a property of this codebase and nothing else enforces it**" | `### Multi-tenancy — the invariant most likely to be broken` |
| "A domain write and its outbox document commit in **ONE MongoDB transaction**" | `### BullMQ is dispatch. It is NEVER the durable record.` |
| "Transactions require a replica set or a sharded cluster. `src/utils/mongoTopology.ts` asserts this at boot and refuses to start on a standalone" | same |
| "in Mongo they are unique compound indexes" | `### Idempotency lives in unique compound indexes` — the heading itself moves |
| the shared `mongodb-memory-server` replica set, and `fileParallelism: false` because every integration file shares one | `### Reviewer test isolation is a registry, not a convention` |
| "MongoDB + Mongoose, own database inside the shared Oxy instance" (the plan table) | `## Where the plan and the ecosystem disagree, the ecosystem wins` |

**The `databaseIdentity.ts` entry is the one to think about rather than
translate.** It exists because `mongoose.connect(uri, { dbName })` OVERRIDES the
database named in the URI, so a wrong constant silently reads another Oxy
product's live data. PostgreSQL has no equivalent override — the database is in
the connection string and nothing supersedes it — so the hazard genuinely goes
away. Retire the guard and its three companions together, and say in the ADR that
the risk it covered no longer exists; do not port a guard whose failure mode is
gone, and do not delete it silently either.

The tenant-isolation entry is the one that gains a guarantee: today isolation is
enforced only by `db/tenantScope.ts` and review, and under RLS it becomes a
property of the database. `tenantScope.ts` should not simply be deleted — the
composite key `{organizationId, applicationId}` and the rule that a caller may
never supply it are still the contract; only the ENFORCEMENT moves.

## 3. Two things nothing in Oxy has today

**3.1 A second database role.** The migrator/app split means two roles and a
two-connection-string contract. `oxy-infra`'s runbook 30
(`docs/runbooks/30-postgres-database-provisioning.md`) is written for the
one-role model and states, at §0:

> **There is no `GRANT` anywhere in this runbook.** If you find yourself writing
> one, the database was created by the wrong role. Fix the ownership; do not
> paper over it with grants.

That is **correct for every Oxy database that exists today and wrong for this
one.** Whoever provisions CrowdSource will be told by the runbook that their
correct design is a mistake. It needs a documented successor — a named variant
for the two-role case covering `ALTER DEFAULT PRIVILEGES` — landing WITH the
provisioning change, not after it. Record it as a claim with a successor rather
than as an error: the one-role rule stays right for everything else.

**3.2 RLS itself.** No Oxy service uses Row Level Security. Whatever the cutover
decides about `SET LOCAL` vs a session role, connection pooling interaction, and
what happens on a pooled connection that forgets to set the tenant, is the first
instance of that pattern in the ecosystem and should be written down where the
next service can find it.

## 4. Facts that are already settled and should not be re-litigated

- **There is no data migration, and the production database is why.** It holds
  **2 documents**, both `reviewer_profiles` (measured 2026-08-09). The specs
  already decided this — `docs/superpowers/specs/2026-08-06-crowdsource-app-postgres-design.md`
  and the scoping report both say do not build one. The cutover starts empty.
  Anything later implying a backfill is wrong; keep the measurement beside the
  decision so nobody re-opens it from first principles.
- **`WEBHOOK_SECRET_ENCRYPTION_KEY`'s provenance is correctly documented here** —
  `deploy-aws.yml` carries it in `SSM_SECRET_ALLOWLIST` and the task definition
  maps it to `/oxy/crowdsource/WEBHOOK_SECRET_ENCRYPTION_KEY`. It was live in
  production without a terraform declaration until oxy-infra #44; that was an
  infrastructure gap, not a documentation one, and no claim in this repo needs
  changing. Noted so the next person auditing it does not "fix" prose that is
  right.
- **`applicationId` comes from the credential, never the request body**, and the
  tenant key is the composite `{organizationId, applicationId}`
  (`db/tenantScope.ts`'s `TENANT_KEYS`). Both survive the cutover unchanged. The
  docs' singular phrasing — "a tenant id the caller can choose is not isolation"
  — is about what a CALLER supplies and is accurate; it is not a claim that there
  is one column, and does not need editing.

## 5. Config no source-level guard scans

| Location | What moves |
|---|---|
| `.github/workflows/deploy-aws.yml` | `SSM_SECRET_ALLOWLIST: MONGODB_URI …` and the task-definition secret block gain `DATABASE_URL`; `MONGODB_URI` leaves both |
| `.github/scripts/assert-own-database.sh` | reads `databaseIdentity.ts` before a release is built — retires with it (§2) |
| `.github/scripts/test-assert-own-database.sh` | the mutation test for that guard |
| CI workflow | the `mongodb-memory-server` binary download and cache, once the backend suite stops needing a replica set |
| ECS task definition `oxy-crowdsource` | `MONGODB_URI` off the definition and out of SSM |

Homiio shipped a ~200 MB `Cache mongod binary` step for months after deleting the
package, because nothing scans workflow env vars. Delete the cache and the env
vars in the same PR as the dependency.
