# Rules for contributors and agents

The reasoning behind the rules in [`AGENTS.md`](../AGENTS.md), kept here so the
root file stays short. Each rule breaks silently when violated. The longer
engineering reasoning is in
[`architecture/engineering-rules.md`](./architecture/engineering-rules.md).

## Origin

The repository began as a fork of Mention, taken for its Expo/Bloom/monorepo
foundation only. Nothing of Mention the product survives, and no code should
reach back for one. `.plan/PLAN.md` is binding on product; where its plumbing and
the ecosystem disagree, the ecosystem wins.

## Packages

Two published packages, not five. `contracts` stays its own because it must exist
exactly once in a consumer's tree (two copies type-check clean and fail every
delivery at runtime) and because a React Native UI package needs its types
without a server-only client in the phone bundle. Everything else is `core`, one
package with four entry points (`/express`, `/outbox`, `/outbox/postgres`,
`/testing`), so a consumer cannot install a client and a receiver that disagree.

The root of `core` must stay importable by a consumer that only files reports:
express, drizzle, postgres and `@oxy.so/db` are optional peers reached only
through `/express` and `/outbox`. An import added to `src/index.ts` that pulls
one in is a regression no test will name.

Do not record per-package build status in `AGENTS.md`. A sentence that called the
reviewer app "the foundation without review surfaces" outlived six shipped review
screens and read as an instruction not to look.

## Build

Rebuild `contracts` before believing a red typecheck. Every other package imports
its built `dist`, so after a rebase they compile against the previous build and
report newly landed symbols as missing (`TS2305`) in files nobody touched.

## Data and idempotency

- The PostgreSQL outbox row is the durable work record. There is no queue
  dependency. A domain write and its outbox row commit through the same Drizzle
  transaction; workers claim durable rows with bounded leases. Never create work
  without the outbox row that makes it re-derivable.
- Isolation is enforced by PostgreSQL RLS and the scoped repository types. A
  `TenantContext` is built only by `createTenantContext`, from the authenticated
  service credential, never from a body, path, query or header. Tenant-owned
  repositories require `TenantScopedHandle`, minted only after both `SET LOCAL`
  parameters are written and read back inside a transaction. Never bypass it with
  the pool. Public ids are ULID or UUID, never sequential.
- Idempotency lives in unique compound indexes and they are required: one per
  retry-safe operation, applied by PostgreSQL migrations. The list is in
  `architecture/engineering-rules.md`; each is what makes a retry safe rather than
  duplicating a case, a review or a penalty.
- `applicationId` is read off the credential and no surface can carry one. Never
  add an `applicationId` option, field or parameter; the envelope's copy exists so
  a mismatch can be detected.
- A default must be a pinned version, never "whatever is current".
  `DEFAULT_POLICY` must equal the backend's baseline constants. A resolved-at-
  ingress "latest" would move the policy under an application that changed
  nothing and split the dedup key, giving one post two cases.
- Nothing the client composes may vary between two deliveries of one report.
  Ingress fingerprints the whole envelope, so an invented timestamp, a random id
  or an unsorted list turns a legitimate outbox retry into a permanent 409,
  silently, days later, as moderation work stuck in a queue.
- A backend data cutover is freeze, export, import, reconcile, never an in-place
  guess. Preserve every existing identifier, prove the PostgreSQL target empty,
  and compare canonical counts plus SHA-256 digests before deploy.
- Every place an Oxy id or principal id lands is erased on `account.deleted`
  ([`architecture/account-erasure.md`](./architecture/account-erasure.md)). A new
  one joins the seed of `accountErasure.integration.test.ts`, whose sweep then
  fails until it is handled.

## Tests

- Take a reviewer `(family, language)` cell from
  `packages/backend/src/__tests__/support/reviewerAxes.ts`; never declare a pair
  inline. Every integration file shares one disposable PostgreSQL database, so the
  eligibility pair is the only thing keeping two files apart. Assert on the FAIL
  count: a collision throws in a hook, which `bun test` reports as one failed
  `(unnamed)` test while the file's own tests drop out of the total.
- Every guard is mutation-proven. `packages/core/scripts/test-invariants.mjs`
  deletes each guard in turn and asserts the specific named test goes red. A
  mutation whose failure mode is a timeout carries no information; bound it so it
  fails fast and named.

## Frontend

- `app/_layout.tsx` is the sole authority for the `(auth)` and `(app)` swap. A
  child screen must never navigate across that boundary on the same signal.
- Case material must never reach device storage, logs or analytics.
  `utils/storage.ts` is for preferences only.

## Oxy integration

- Two authentication surfaces, neither bypassing the other. Reviewer, console and
  Trust & Safety callers are Oxy sessions verified with `@oxy.so/core/server`,
  never an app-local bearer parser or `AuthRequest` type, defined once in
  `src/modules/identity/oxySession.ts`. Application-API callers are service
  credentials. A service credential must never reach a session route, and an Oxy
  session must never satisfy an application-API route.
- Three authorizations on that one identity, not interchangeable: a reviewer
  profile, an organization membership, a Trust & Safety role (the Oxy application
  permission `trust_safety.<role>`, declared in oxy's first-party registry and
  held by a role in the owning org, oxy ADR 0056; never a per-person grant or a
  local list). A verified session grants none of them. No route here grants one.
- A console caller names a resource; it never names a tenant. `organizationId` is
  read off the stored row, and a membership is required before a `TenantContext`
  exists. No console handler reads one from a body or query string.
- Security helpers come from the SDK: `safeFetch`, `createOxyCors`,
  `verifySecret`. Media is `oxyServices.getFileDownloadUrl` plus Bloom's
  `ImageResolver`, never a per-app URL helper or an `avatarUrl` DTO field.
- One `OxyProvider`, web and native alike. No app-local auth routes, token
  providers or `Authorization` headers.
- `EXPO_PUBLIC_OXY_CLIENT_ID` has no default: no OAuth client is registered yet,
  and hard-coding one would borrow another product's identity.

## Deployment

Port `3000`, `api.crowdsource.oxy.so`, reviewer and console are Cloudflare
Workers (`packages/*/wrangler.toml`), never Pages, ECR `oxy/crowdsource`. A push
to `main` runs `deploy-aws.yml` and `deploy-frontends.yml`, both gated on CI. See
`architecture/engineering-rules.md` section "AWS deployment".

- A frontend hostname carries no hand-written DNS record. `custom_domain` claims
  it and Cloudflare writes the record; a Worker custom domain refuses a hostname
  that already has externally managed records (`code: 100117`), so adding one back
  breaks the deploy. `workers_dev = false` is likewise load-bearing: without it
  the app gets a second public hostname that is in no CORS allowlist and no
  redirect-URI list.
- `DATABASE_URL` is required to boot. Absent, the task exits at start rather than
  degrading a route, so it must be live in the task definition before an image
  requiring it rolls out.
- `RUN_MIGRATIONS` stays `false` until the migration task definition lands with
  the MIGRATOR credential, which the serving task must never carry. Turned on
  earlier, every deploy fails at the migration step.
- One environment. There is no sandbox or staging deployment.

## Planning

`.plan/` holds the approved specification and the working checklist. It is
gitignored, local-only, and must never be deleted or committed.

## AGENTS.md budget

`AGENTS.md` is prepended to every agent session, so its bytes are paid on every
task. `scripts/check-agents-md-size.mjs` (`bun run validate:agents-md`) enforces
the budget; an addition that exceeds it moves material here in the same edit.
