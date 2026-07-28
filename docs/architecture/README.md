# Architecture

Architecture decision records and the module boundaries of the backend's modular
monolith.

Nothing is recorded here yet. The first ADRs are the ones the plan requires
before implementation: the service architecture (own repository, modular
monolith, Oxy Auth), the universal case-envelope schema, and the split of
reputation into contribution, conduct, reporting, reviewing and personhood.

One more is owed on top of those: an ADR of **divergence from the
specification**. The plan's infrastructure choices (PostgreSQL, S3 with KMS,
SQS, three environments, Row Level Security) were written without context on the
Oxy ecosystem, and CrowdSource follows the ecosystem instead — MongoDB, the Oxy
media chokepoint, BullMQ over the existing Valkey, one environment, tenant
isolation enforced in code. The plan's product content is binding; its plumbing
is not.
