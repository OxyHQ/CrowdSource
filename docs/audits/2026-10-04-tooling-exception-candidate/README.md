# Inactive tooling exception candidate

This proposal does not change `audit:security` or `security-audit-exceptions.json`.
The existing CI refusal remains active until review. The absolute upper expiry is
2026-10-09 22:00:00 UTC; the verifier refuses an extension or a clock at/after it.

The authenticated CI log for run 37156267394 reports three high advisories:
[braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
[http-cache-semantics](https://github.com/advisories/GHSA-ch52-4w7c-c8xp), and
[node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
GitHub's advisory metadata currently lists no patched release for those entries.
The reviewed lock contains 3.0.3, 4.2.0 and 1.4.0 respectively. This proposal
makes no claim that those packages or an untested Forge replacement are safe.

`census.json` records the complete reverse dependency subgraph: 58 package
records with archive integrities, dependency edges/ranges, workspace roots and
patch declarations. Only console/reviewer roots reach these packages. Forge is
under Expo CLI/certificate tooling, braces under Metro/Jest, and HTTP cache
semantics under the reviewer's development ngrok client. No backend/contracts
root reaches them, including backend development dependencies. Docker installs
only backend/contracts with development, peer and optional dependencies omitted;
its exact bytes are an additional boundary pin. The verifier rejects package,
version, archive, parent, range, workspace, patch and Docker drift, and matches
both advisory identifier and package. Ordinary, unreviewed advisories still fail.

Compensations for an eventual approved activation: build/test only trusted
repository-owned patterns; do not use Expo/ngrok development servers as a
production ingress or enable untrusted certificate/signature verification paths.
The current static-export pipeline supplies no customer-selected glob patterns.
This is a bounded tooling exception, not a runtime vulnerability dismissal.

After final registry installation, rebuild both exports with external source
maps and run `inspectExportMaps` from `scripts/security-tooling-exceptions.mjs`.
It requires every emitted `_expo/static/js` bundle to have a populated standard
map, records bundle/map hashes and rejects the three package paths. Preserve the
exact build command, exit status and those receipts, then withhold the source
maps from public deployment artifacts. The maps are trusted local build output,
not independently authenticated evidence; this control does not replace source
review or the final backend image dependency census. Both final checks remain
pending and no existing bundle is relabeled as final registry evidence.

The 21 local controls exercise exact matches, expiry and malformed time, every
drift category above, an unrelated Oxy package-version change, missing maps and
each prohibited package in synthetic maps. Synthetic-map controls are tests of
the inspector, not proof about the actual exported products. Candidate installed
lock and committed lock produce the same tooling graph fingerprint.
