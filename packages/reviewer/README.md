# @crowdsource/reviewer

The CrowdSource reviewer app — Expo Router + React Native Web, so one codebase
serves web and native.

Today it is the foundation only: theming, the Oxy session, i18n and routing.
The reviewer surfaces (onboarding, training, "review next case", the case
viewer, recusal, history, reliability, wellbeing) are built on top of it.

## Invariants this app must never break

- Nobody chooses the case they review. The server issues an assignment; there is
  no case search, no shareable case link, no public queue.
- A reviewer never sees partial votes, other jurors' identities, the reporter's
  identity or anyone's reputation.
- Case material never reaches device storage, logs or analytics.

## Structure

- `app/_layout.tsx` — the SOLE authority for the `(auth)` ↔ `(app)` swap. Child
  screens must never navigate across that boundary on the same signal.
- `components/providers/AppProviders.tsx` — the whole provider tree, including
  the one `OxyProvider` that owns the session on web and native alike.
- `lib/` — the app-level singletons: Oxy client, React Query client, logger,
  i18n, theme persistence.

## Commands

```bash
bun run dev          # Expo dev server (tunnel)
bun run dev:local    # Expo dev server (LAN)
bun run web          # web only
bun run build        # static web export -> dist/
bun run typecheck    # tsc --noEmit
bun run test         # jest
```
