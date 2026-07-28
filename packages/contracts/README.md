# @oxyhq/crowdsource-contracts

The versioned contracts every CrowdSource surface agrees on — the backend, the
reviewer and console clients, the published SDKs, and third-party integrators.

The package is currently empty: it is the boundary the contracts will be
published from, and it exports nothing until a real schema lands.

## Rules

- Contracts only. No application logic, no transport clients, no runtime that
  belongs to one surface.
- Schemas are authored with Zod and exported as JSON Schema too, so integrators
  who do not use TypeScript validate against the same definition.
- `schemaVersion` travels inside the payload (for example
  `crowdsource.case.v1`) and is validated separately from the `/v1` route
  version. Additive changes do not bump either.
- A published contract version is immutable. Widening is additive; narrowing
  needs a new version.
- Nothing here may depend on a single tenant's vocabulary. Application-specific
  subject types and policies are data, registered per application, never types
  in this package.
