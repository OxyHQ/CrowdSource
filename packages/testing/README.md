# @oxyhq/crowdsource-testing

Fixtures, a webhook simulator and a sandbox harness for integrating with
CrowdSource.

The package is currently empty: it is the boundary the fixtures will be
published from, and it exports nothing until there are real contracts to build
them against.

## Rules

- Fixtures are synthetic. Real reported material, real evidence and real
  reviewer identities never ship in a test package.
- A fixture that no longer validates against the published contracts is a
  failure, not something to loosen: it is how an integrator learns a contract
  moved.
