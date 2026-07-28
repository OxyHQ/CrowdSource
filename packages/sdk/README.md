# @oxyhq/crowdsource

TypeScript client for the CrowdSource moderation API — report creation with
idempotency keys, presigned evidence uploads, and case and decision reads.

The package is currently empty: it is the boundary the client will be published
from, and it exports nothing until the API it wraps exists.

## Rules

- A report is delivered from the integrator's own outbox, never from a request
  handler. A 2xx from an application means the report is stored locally with a
  durable retry path — not that a synchronous call to CrowdSource succeeded.
- `applicationId` is derived server-side from the service credential. The client
  never sends one, and a caller cannot set one.
- Every write carries an idempotency key. Retrying a delivery must return the
  same `reportId`, never create a second report.
