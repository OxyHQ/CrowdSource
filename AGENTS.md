# CrowdSource

Multi-tenant participatory moderation infrastructure: applications send universal
reports, randomly drawn juries review them blind, a consensus engine publishes
versioned decisions, and webhooks return them. A product of its own; no code reaches back for Mention.

## Commands

```bash
bun install
bun run dev                # or dev:backend / dev:reviewer / dev:console
bun run build              # contracts, backend, core
bun run test               # contracts + backend (bun test), core (vitest), apps (jest)
bun run lint               # Biome + per-package lint; lint:fix and format write
bun run check              # full CI gate: doctor, audit, build, typecheck, lint
bun run validate:agents-md # size budget for AGENTS.md
```

Rebuild `contracts` (`bun run build:contracts`) before believing a red typecheck:
other packages import its built `dist` (why: [agent-rules](docs/agent-rules.md)).

## Map

- `packages/contracts` and `packages/core` are the two published packages
  (`@crowdsource.you/*`); `backend`, `reviewer` (Expo) and `console` are apps.
- `docs/README.md` indexes everything; `docs/architecture/engineering-rules.md`
  holds the reasoning behind each rule; `docs/runbooks/` covers operations.

## Invariants (a change that breaks one is wrong even if it passes review)

- Nobody chooses the case they review: the server issues assignments; no case
  search, shareable case link or public queue.
- A reviewer never sees partial votes, other jurors, the reporter or anyone's reputation.
- One qualified person, one vote; reputation affects eligibility and selection, never vote weight.
- A published decision is never edited, only superseded by a new revision.
- One penalty per incident, however many reports.
- Every effect is idempotent, explainable, reversible and carries its policy version.
- Sensitive content never reaches logs, metrics or attestations.
- `inconclusive` is its own outcome and never collapses into `no_violation`.
- `applicationId` comes from the credential, never from a request body, option or parameter.
- No binding proof, no Oxy Trust effect; applications emit reports, CrowdSource emits decisions.

## Conventions that differ from defaults

- Work is durable only via the PostgreSQL outbox row, written in the same Drizzle
  transaction as the domain write; there is no queue (otherwise work is not re-derivable).
- `TenantContext` is built only by `createTenantContext` from the service
  credential; tenant repositories take `TenantScopedHandle` (RLS isolation).
- Every retry-safe operation has a required unique compound index (otherwise a retry duplicates a case).
- Defaults are pinned versions, never "latest"; `DEFAULT_POLICY` equals the backend baseline constants.
- Nothing the client composes may vary between deliveries of one report
  (no invented timestamps, random ids or unsorted lists), or retries become permanent 409s.
- `core` root imports no optional peer (express, drizzle, postgres, `@oxy.so/db`); those live behind `/express` and `/outbox`.
- Take reviewer `(family, language)` cells from `packages/backend/src/__tests__/support/reviewerAxes.ts`, never inline pairs.
- Session callers use `@oxy.so/core/server` via `packages/backend/src/modules/identity/oxySession.ts`;
  service credentials never reach session routes, nor sessions application routes.
- Trust & Safety access is the Oxy application permission `trust_safety.<role>` held by an org role (oxy ADR 0056).
- A console caller names a resource, never a tenant; `organizationId` is read off the stored row.
- `packages/reviewer/app/_layout.tsx` alone swaps `(auth)` and `(app)`; one `OxyProvider`; no app-local auth routes or tokens.
- Case material never reaches device storage, logs or analytics.
- `EXPO_PUBLIC_OXY_CLIENT_ID` has no default; no OAuth client is registered yet.
- Reviewer and console deploy as Cloudflare Workers, never Pages; frontend hostnames get
  no hand-written DNS records and keep `workers_dev = false`.
- Data cutovers are freeze, export, import, reconcile with count and SHA-256 comparison.

## Boundaries

Never:
- bypass RLS or scoped repositories with the pool (tenant isolation);
- add a queue dependency (the outbox is the work record);
- set `RUN_MIGRATIONS=true` before the migrator task definition exists (every deploy fails);
- delete or commit `.plan/` (local-only specification);
- record per-package build status here (it goes stale).

Ask first: new `account.deleted` erasure sites (add to the seed of
`accountErasure.integration.test.ts`), new deployment environments (there is only one).

## Testing

`bun run test` for logic; `bun run check` before a PR. Every guard is
mutation-proven by `packages/core/scripts/test-invariants.mjs`; bound mutations
so they fail fast and named. Done means `check` and the affected package tests pass.

## PR and commits

Branch from `main`; one concern per PR. Merging a version bump publishes npm
packages through `release-packages.yml`; never publish from a laptop
([npm releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md)).

## Secrets

`DATABASE_URL` is required to boot and comes from the ECS task definition; the
migrator credential never reaches the serving task. Never print `*_DATABASE_URL` values.

## Links

[docs index](docs/README.md) | [agent-rules](docs/agent-rules.md) |
[engineering rules](docs/architecture/engineering-rules.md) |
[Oxy lint and format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md) |
[Oxy engineering standards](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md) |
[Bloom app conventions](https://github.com/OxyHQ/Bloom/blob/main/docs/app-conventions.mdx) |
[Oxy build and runtime traps](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/build-and-runtime-traps.md)

Owner: Nate Isern (@NateIsern). Last reviewed: 2026-11-11.
