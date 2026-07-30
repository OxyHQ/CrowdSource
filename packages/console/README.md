# @crowdsource/console

The CrowdSource developer and Trust & Safety console. Expo Router + React Native
Web + Bloom, **web only** — one static export, no native build.

## The two audiences are a security boundary, not a navigation choice

- **Developer** — manages ONE application at a time inside an organization they
  hold a seat in: service credentials, webhook endpoints and delivery health,
  quotas and usage, their own cases and decisions, organization members. They see
  their own tenant and nothing else.
- **Trust & Safety** — sees across tenants: application standing, promotion and
  restriction, the dead-letter queue, platform metrics. Reachable only with a role
  on a `trust_safety_staff` row, which no route in the service grants.

Both are one app and one deployment. The Trust & Safety views are gated by a role,
not by a second build — but the API behind them is a separate router with its own
authorization, so hiding the navigation is a courtesy and the 403 is the boundary.

## What the console never shows

Whatever role is held and whichever tenant is being viewed:

- a reviewer's identity, in any form, or a count of who sat on a panel;
- an individual juror's vote or review record;
- a reporter's identity or their per-application reporter fingerprint;
- reported content — case detail carries resource metadata and digests, never a
  payload.

Aggregate jury figures (size, decisive votes, agreement) DO appear on a decision,
because the application API and §10.7's webhook envelope already publish them.
The backend enforces all of this in `packages/backend/src/modules/console/`; the
reasoning per field is in `caseExplorer.service.ts`.

## Session

ONE `OxyProvider` from `@oxyhq/services`, web included, `webAuthMode="popup"`. No
app-local auth routes, token providers or `Authorization` headers; the API client
is `oxyServices.createLinkedClient({ baseURL })`. `EXPO_PUBLIC_OXY_CLIENT_ID` has
no default in source — the value is supplied at build time.

## Not built here yet

§4.2's custom resource schemas, policy-set builder and simulated-case sandbox, and
§4.3's specialist queues, appeals and cross-application incidents. The queues in
particular are blocked rather than skipped: `cases` and `decisions` are
tenant-scoped collections with no cross-tenant read, and §12.9 puts cross-tenant
correlation behind a privileged `Incident` module that does not exist.

## Commands

```bash
bun run dev:console        # from the repository root
bun run build:console      # static web export into dist/
bun run --cwd packages/console test
bun run --cwd packages/console typecheck
```

## Deployment

Cloudflare Pages project `crowdsource-console` at `console.crowdsource.oxy.so`,
via the `deploy-console` job in `.github/workflows/deploy-frontends.yml`. That job
is **gated on the repository variable `CROWDSOURCE_CONSOLE_PAGES` being `ready`**:
it creates a Pages project and writes a DNS record into the `oxy.so` zone, which
carries every live Oxy backend, so merging the workflow must not do either on its
own. The console host also has to be registered as an additional redirect URI on
CrowdSource's Oxy application before interactive sign-in works there.
