# CrowdSource documentation

| Directory | Holds |
| --- | --- |
| `architecture/` | Architecture decision records and the module boundaries of the modular monolith. |
| `api/` | The application, reviewer and internal HTTP contracts, webhook events and error conventions. |
| `policies/` | The universal taxonomy, policy-set versioning rules and the Oxy conduct policy. |
| `runbooks/` | Operational procedures: rollouts, incident response, retention, legal holds, secret rotation. |

Two rules keep this tree honest:

- A document that describes behaviour the code does not have is a bug. Write the
  document when the behaviour lands, not before.
- Package `files` lists exclude `docs/`, so no consumer ever trips over a stale
  claim here. Anything load-bearing enough to be relied on gets a test that
  fails when it drifts.
