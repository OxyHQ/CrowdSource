# CrowdSource

Multi-tenant **participatory moderation infrastructure**: applications send
universal reports, randomly drawn juries review them blind, a consensus engine
publishes versioned decisions, and webhooks return those decisions to the
application. A product of its own, not a feature of any app that uses it.

The repository began as a fork of Mention, taken for its Expo/Bloom/monorepo
foundation only. Nothing of Mention the product survives, and no code should ever
reach back for one.

> **For anything about how this works, read `docs/README.md`** —
> `docs/architecture/` holds the decisions and
> `docs/architecture/engineering-rules.md` the reasoning behind every rule below.
> `.plan/PLAN.md` is binding on PRODUCT; where its plumbing and the ecosystem
> disagree, the ecosystem wins.
>
> **This file carries only RULES — things that break silently if you get them
> wrong.** Org-wide standards are at
> <https://github.com/OxyHQ/engineering/blob/main/AGENTS.md>; the parent files
> (`~/AGENTS.md`, `~/Oxy/AGENTS.md`) hold the agent team, the shared-SDK rules
> and the Bloom/Expo gotchas. Do not repeat any of them here.
>
> **Budget: under 12 KB**, enforced by `scripts/check-agents-md-size.mjs`
> (`bun run validate:agents-md`). It is prepended to EVERY agent session, so its
> bytes are paid on every task forever, and it grows by accretion — one
> reasonable paragraph at a time, invisible per-commit. An addition that pushes
> it over is paid for in the SAME edit.

## Invariants (no change may break these)

From the approved product specification. Not preferences: a change that violates
one is wrong even if it passes review.

- **Nobody chooses the case they review.** The server issues an assignment. No
  case search, no shareable case link, no public queue.
- **A reviewer never sees partial votes**, other jurors' identities, the
  reporter's identity, or anyone's reputation.
- **One qualified person, one vote.** Reputation affects eligibility and
  selection probability, never the weight of a vote inside a jury.
- **A published decision is never edited, only superseded.** An appeal creates a
  new revision.
- **One penalty per incident.** A hundred reports about the same material produce
  one case and one consequence.
- **Every effect is idempotent, explainable and reversible**, and carries the
  policy version it was decided under.
- **Sensitive content never reaches logs, metrics or attestations.**
- **Absence of consensus is neither guilt nor innocence.** `inconclusive` is its
  own outcome and must never collapse into `no_violation`.
- **`applicationId` comes from the credential, never from the request body.**
- **No binding proof, no Oxy Trust effect.** An application emits a report;
  CrowdSource emits a decision. That direction is one-way.

## Layout

```
packages/
  contracts/    @oxyhq/crowdsource-contracts  Zod + JSON Schema contracts (published)
  backend/      @crowdsource/backend          Express modular monolith
  reviewer/     @crowdsource/reviewer         Expo Router reviewer app (web + native)
  console/      @crowdsource/console          Developer + Trust & Safety console (web only)
  sdk/          @oxyhq/crowdsource            TypeScript client (published)
  sdk-express/  @oxyhq/crowdsource-express    Webhook middleware (published)
  testing/      @oxyhq/crowdsource-testing    Fixtures + webhook simulator (published)
  app/          @oxyhq/crowdsource-app        The application half (published)
```

**Do NOT record per-package build status here** — read the tree. The sentence
that used to sit in this spot called the reviewer app "the foundation without
review surfaces" long after six review screens had shipped, so it read as an
instruction not to go looking.

## Commands

```bash
bun run dev / dev:backend / dev:reviewer / dev:console
bun run build              # contracts, backend, SDKs
bun run build:reviewer / build:console
bun run check              # doctor + workflows + security audit + build + typecheck + lint
bun run test               # contracts + backend (vitest) + reviewer and console (jest)
bun run validate:agents-md
```

**Rebuild `contracts` before believing a red typecheck.** Every other package
imports its BUILT `dist`, so after a rebase they compile against the previous
build and report newly-landed symbols as missing (`TS2305`) in files nobody
touched. It reads exactly like someone else's broken commit.

## The rules

- **The PostgreSQL outbox row is the durable work record.** There is no queue
  dependency. A domain write and its outbox row commit through the SAME Drizzle
  transaction; workers claim durable rows with bounded leases. Never create work
  without the outbox row that makes it re-derivable.
- **`@oxyhq/crowdsource-app` is PostgreSQL-only.** Do not restore a Mongoose
  export, dependency or runtime path. Adopter migrations preserve exact ids and
  reconcile counts plus canonical SHA-256 digests against an empty target.
- **Isolation is enforced by PostgreSQL RLS and the scoped repository types.** A
  `TenantContext` is built ONLY by `createTenantContext`, from the authenticated
  service credential — never from a body, path, query or header. Tenant-owned
  repositories require `TenantScopedHandle`, minted only after both `SET LOCAL`
  parameters are written and read back inside a transaction. Never bypass it
  with the pool. Public ids are ULID or UUID, never sequential.
- **Idempotency lives in unique compound indexes and they are REQUIRED** — one
  per retry-safe operation, applied by PostgreSQL migrations. The list is
  in `docs/architecture/engineering-rules.md`; each is what makes a retry safe
  rather than duplicating a case, a review or a penalty.
- **`applicationId` is read off the credential and no surface can carry one.**
  Never add an `applicationId` option, field or parameter — the envelope's copy
  exists so a mismatch can be DETECTED.
- **A default must be a pinned version, never "whatever is current".**
  `DEFAULT_POLICY` must equal the backend's baseline constants; a resolved-at-
  ingress "latest" would move the policy under an application that changed
  nothing and split the dedup key, giving one post two cases.
- **Nothing the client composes may vary between two deliveries of one report.**
  Ingress fingerprints the whole envelope, so an invented timestamp, a random id
  or an unsorted list turns a legitimate outbox retry into a permanent 409 —
  silently, days later, as moderation work stuck in a queue.
- **A backend data cutover is freeze/export/import/reconcile, never an in-place
  guess.** Preserve every existing identifier, prove the PostgreSQL target empty,
  and compare canonical counts plus SHA-256 digests before deploy. The repository
  runtime cut does not assert that production data was migrated.
- **Take a reviewer `(family, language)` cell from
  `src/__tests__/support/reviewerAxes.ts`; never declare a pair inline.** Every
  integration file shares ONE disposable PostgreSQL database, so the eligibility
  pair is the only thing keeping two files apart. When checking for this class of bug, assert on
  the FILE count — a collision throws in a hook, which Vitest reports as
  `Test Files 1 failed` while the skimmed line reads `Tests 40 passed`.
- **`app/_layout.tsx` is the SOLE authority for the `(auth)` ↔ `(app)` swap.** A
  child screen must never navigate across that boundary on the same signal.
- **Case material must never reach device storage, logs or analytics.**
  `utils/storage.ts` is for preferences only.
- **Every guard is mutation-proven.** `packages/app/scripts/test-invariants.mjs`
  deletes each guard in turn and asserts the SPECIFIC named test goes red. **A
  mutation whose failure mode is a timeout carries no information** — bound it so
  it fails fast and NAMED.

## Oxy integration

- **Two authentication surfaces, neither bypassing the other.** Reviewer, console
  and Trust & Safety callers are Oxy sessions verified with `@oxyhq/core/server`
  — never an app-local bearer parser or `AuthRequest` type — defined ONCE in
  `src/modules/identity/oxySession.ts`. Application-API callers
  are service credentials. A service credential must never reach a session route,
  and an Oxy session must never satisfy an application-API route.
- **THREE authorizations on that one identity, not interchangeable** — a reviewer
  profile, an organization membership, a Trust & Safety role. A verified session
  grants none of them: every Oxy account authenticates. There is deliberately no
  HTTP route that grants a staff role.
- **A console caller names a resource; it never names a tenant.**
  `organizationId` is read off the STORED row, and a membership is required
  before a `TenantContext` exists. No console handler reads one from a body or
  query string.
- Security helpers come from the SDK: `safeFetch`, `createOxyCors`,
  `verifySecret`. Media is `oxyServices.getFileDownloadUrl` plus Bloom's
  `ImageResolver` — never a per-app URL helper or an `avatarUrl` DTO field.
- **ONE `OxyProvider`**, web and native alike. No app-local auth routes, token
  providers or `Authorization` headers.
- **`EXPO_PUBLIC_OXY_CLIENT_ID` has no default** — no OAuth client is registered
  yet, and hard-coding one would borrow another product's identity.

## Deployment

Port `3000` · `api.crowdsource.oxy.so` · reviewer and console on Cloudflare
Pages · ECR `oxy/crowdsource` · `git push origin main` → `deploy-aws.yml` +
`deploy-frontends.yml`, both gated on CI. Detail:
`docs/architecture/engineering-rules.md` § AWS deployment.

- **`DATABASE_URL` is required to boot** — absent, the task exits at start rather
  than degrading a route, so it must be live in the task definition before an
  image requiring it rolls out.
- **`RUN_MIGRATIONS` stays `false` until the migration task definition lands**
  with the MIGRATOR credential, which the serving task must never carry. Turned
  on earlier, every deploy fails at the migration step.
- One environment. There is no sandbox or staging deployment.

## Planning

`.plan/` holds the approved specification and the working checklist. It is
gitignored, local-only, and must never be deleted or committed.
