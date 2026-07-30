# API

The HTTP contracts: the application API (`/v1/reports`, uploads, cases, appeals,
enforcement, webhook endpoints), the reviewer API (assignments, reviews,
recusal, profile, training) and the internal reputation bridge, plus the webhook
event catalogue, signature scheme and error conventions.

- [`console.md`](./console.md) — the developer and Trust & Safety console API: the
  three authorizations built on one Oxy session, how a tenant is established from a
  path without becoming an IDOR, what a developer's case view does and does not
  contain, and the quotas that are actually enforced.

The rest is not documented yet, but it is reachable. `packages/backend/src/app.ts`
is the current answer to "what exists": reports, cases, appeals, decisions and
webhook endpoints on the application API; the reviewer's profile, preferences,
training, calibration, review history and the four assignment-scoped routes on the
reviewer API; and the console and Trust & Safety routers. **Not served:** uploads —
the presigned design was superseded by the Oxy media chokepoint before it was built,
and an asset now carries a bare `fileId` — plus enforcement acknowledgements and the
reputation bridge, which lives in Oxy Trust rather than here.

The generated JSON Schema from `@oxyhq/crowdsource-contracts` is the reference the
prose here will point at, so integrators validate against the same definition the
server enforces.
