# API

The HTTP contracts: the application API (`/v1/reports`, uploads, cases, appeals,
enforcement, webhook endpoints), the reviewer API (assignments, reviews,
recusal, profile, training) and the internal reputation bridge, plus the webhook
event catalogue, signature scheme and error conventions.

Nothing is documented here yet: no endpoint exists. The generated JSON Schema
from `@oxyhq/crowdsource-contracts` is the reference the prose here will point
at, so integrators validate against the same definition the server enforces.
