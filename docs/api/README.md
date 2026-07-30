# API

The HTTP contracts: the application API (`/v1/reports`, uploads, cases, appeals,
enforcement, webhook endpoints), the reviewer API (assignments, reviews,
recusal, profile, training) and the internal reputation bridge, plus the webhook
event catalogue, signature scheme and error conventions.

- [`console.md`](./console.md) — the developer and Trust & Safety console API: the
  three authorizations built on one Oxy session, how a tenant is established from a
  path without becoming an IDOR, what a developer's case view does and does not
  contain, and the quotas that are actually enforced.

The rest is not documented yet. The generated JSON Schema from
`@oxyhq/crowdsource-contracts` is the reference the prose here will point at, so
integrators validate against the same definition the server enforces.
