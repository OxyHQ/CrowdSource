# @oxyhq/crowdsource-contracts

The versioned contracts every CrowdSource surface agrees on — the backend, the
reviewer and console clients, the published SDKs, and third-party integrators.

Authored with Zod; the same contracts are exported as JSON Schema
(`crowdSourceJsonSchema(name)`) so integrators who are not on TypeScript
validate against the same definition.

## Rules

- Contracts only. No application logic, no transport clients, no runtime that
  belongs to one surface.
- `schemaVersion` travels inside the payload (`crowdsource.case.v1`) and is
  validated separately from the `/v1` route version. Additive changes bump
  neither.
- A published contract version is immutable. Widening is additive; narrowing
  needs a new version.
- Nothing here may depend on a single tenant's vocabulary. Application-specific
  subject types and policies are data, registered per application, never types
  in this package.

## Where strictness lands, and why

§10.11 says unknown fields must not break clients, "except where the schema
forbids them for safety". Both halves of that sentence are load-bearing, so the
package splits by direction rather than picking one setting.

| Direction | Setting | Reason |
| --- | --- | --- |
| Inbound from a tenant or reviewer — the Case Envelope tree, review submissions, recusals, policy sets, resource-schema registrations | `.strict()` | A silently dropped field is context an application believes it sent and a jury never sees, or an unreviewed rendering input. A review submission additionally must not tolerate `caseId` / `assignmentId` / `reviewerId`: those come from the assignment the server issued, and "nobody chooses the case they review" is only true if they cannot be supplied. |
| Outbound to a tenant — decisions, webhook envelopes, event payloads | `.loose()` | A newer CrowdSource must never break an older client, and a receiver that persists `event.data` for later processing keeps everything that arrived rather than a stripped subset. |
| Internal, to Oxy Trust — the reputation event | `.strict()` | The event deliberately carries no resource ids and no free text; an unrecognised field is exactly how content reaches a reputation ledger or a signed attestation. Evolution is handled by the `.v1` in the event type. |

Open bags — envelope `metadata`, §5.7 custom payloads, registered JSON Schemas —
are the exception in both directions. They are open by definition but flat or
depth-bounded, scalar-typed where they can be, key-restricted, and free of
prototype-bearing names.

There is deliberately **no lexical filter on content**. CrowdSource carries the
reported material, which is hostile by nature: a harassment report quotes the
harassment, a phishing report quotes the link. A blocklist on text values would
reject the evidence and protect nothing. §5.7's boundary is structural — the
contract has no field anywhere whose value is ever interpreted as markup, a
template, a component or a remote reference.

## What the JSON Schema does not carry

Zod refinements have no JSON Schema equivalent and are dropped by the
conversion. Everything structural survives; every cross-field and
cross-reference rule does not — §5.5 reference resolution, the `oxy_user`
binding-proof requirement, exactly-one-of `uploadId`/`url`, media type
agreement, coarse coordinates, the jury arithmetic, the supersession chain.

A payload that passes the JSON Schema is well-formed, not accepted. The server
validates with Zod and that is the authority.

## Ambiguities in the plan, and how they were resolved

The plan was written as prose, so some of its examples disagree with each other.
Every such case is listed here; none was resolved silently.

| # | Where | The disagreement | Resolution |
| --- | --- | --- | --- |
| 1 | Appendix A vs §5.8 | Digests are written `"sha256:..."` in Appendix A and `"..."` in §5.8. | One canonical form, `sha256:<64 lowercase hex>`. Two notations for one value hash two ways, giving one piece of content two envelope hashes, two `caseDedupKey`s (§7.3), two cases and two penalties for one incident. Appendix A is the reference document, so its notation wins and the bare form is rejected rather than normalised. |
| 2 | Appendix B vs §10.7 | `recommendedActions` is a list of objects (`{action, targetResourceIds}`) in Appendix B and a list of bare strings in §10.7. | Objects on a decision, strings on a review. Appendix B is the reference Decision; a decision that recommends removal without naming what to remove is not actionable. §9.3 writes a review's recommendations as strings and that is kept. `reference-documents.test.ts` pins the §10.7 divergence so widening the contract to accept it has to be a deliberate act. |
| 3 | Appendix B vs §11.6 vs §6.4 | The universal taxonomy version is spelled `taxonomy`, `universal` and `universalTaxonomyVersion` in three places. | Each surface keeps the spelling of its own reference payload: `DecisionPolicyVersions` uses `taxonomy`, `ReputationPolicyVersions` uses `universal`. Both are reference documents in the approved plan and rewriting either here would be a silent edit. **Recommended follow-up:** unify on `{taxonomy, application, oxyConduct}` when the event contract is agreed with OxyHQServices. |
| 4 | §5.3 vs §5.8 | §5.3 lists `dimensions` as minimum data for an image; §5.8's own image resource omits them. | Optional. §5.3's "minimum data" is guidance and its own examples contradict it. Duration IS required for video and audio, where no example contradicts §5.3. |
| 5 | §5.2 vs §5.3 | §5.2 makes `language` apply "where applicable"; §5.3 lists it as minimum data for text. | Optional. §5.2 is the field definition and text of unknown language is real; making it required would push applications into guessing. |
| 6 | §5.5 | `authored_by` relates a resource to a principal, but the id spaces are separate and no example exercises it. | `authored_by` resolves `to` against `principalBindings`; every other relation resolves it against `resources`. Pinned by a test. |
| 7 | §5.1 vs §5.8 vs Appendix A | Which root keys are required. | Required: `schemaVersion`, `applicationId`, `externalReportId`, `subject`, `principalBindings`, `resources`, `relations`, `allegations`, `policy`, `privacy`. Optional: `source`, `urgency`, `metadata` — §5.8 omits exactly those three and Appendix A carries all of them. `resources` and `allegations` additionally need at least one entry. |
| 8 | §9.6 | Enumerates decision outcomes; review outcomes are never enumerated. | Review outcomes are narrower: `violation`, `no_violation`, `insufficient_context`, `content_unavailable`. `inconclusive` is what the engine reports when a panel does not agree — a reviewer cannot fail to agree with themselves, and "the absence of consensus is neither guilt nor innocence" only holds if it is never voted for. `duplicate` and `escalated` are case states. |
| 9 | §11.6 vs §5.1 | The envelope's `principalBindings` always show a `bindingProofId`, but non-Oxy principals have no Oxy identity to prove. | Required when `type` is `oxy_user`, optional otherwise. That keeps "no binding proof, no Oxy Trust effect" structural without locking out every tenant whose users are not Oxy users. On the reputation event, `subject.bindingProofId` is required unconditionally (§11.7.4). |
| 10 | §12.4 | Proposes sandbox + staging + production. | `source.environment` is `production` or `sandbox`. CrowdSource deploys once; sandbox is an application-trust state inside it, per this repository's `AGENTS.md`. |
| 11 | Appendix F vs §5.1 | `applicationId` "comes from the credential, never from the request body", yet every example envelope carries one. | Kept and required, documented as an assertion to be COMPARED with the credential-derived id and rejected on mismatch. The contract cannot enforce this — **the ingress route must**, and it is the highest-risk invariant in the package. |

### Values invented rather than quoted

Three tokens do not appear anywhere in the plan and are named here. They are
listed separately because they are the places a product decision could still
overrule this package.

- **`application_local`** (`FindingScope`). §11.7.5 lets only `oxy_network` and
  `identity_integrity` reach Oxy Trust, so the complement must exist and be
  nameable — §6.5's whole argument is that a local restriction does not become a
  global sanction. Modelling it as an absent field instead would make §11.7.5 a
  presence check, which fails open.
- **`local_user`, `organization`, `bot`, `federated_actor`** (`PrincipalType`).
  §3 defines a principal as "an Oxy user, a local user, an organization, a bot or
  a federated actor" but only ever writes `oxy_user`. The concepts are the
  plan's; the tokens are this contract's.
- **`conflict_of_interest`, `language`, `too_sensitive`,
  `insufficient_context`** (`RecusalReason`). §4.1 lists exactly these four
  grounds in prose and §10.3 asks for a "structured reason".

### Left open on purpose

- **`sensitivityHint`** and **`urgency.hint`** are bounded lowercase tokens, not
  enums. The plan names one value each (`standard`, `normal`) and §7.5 clearly
  implies more. Both are HINTS: the authoritative `sensitivity_class` and
  priority are computed server-side by triage (§7.4, §12.8), and access to
  sensitive material is gated on the computed class, never on what a tenant
  asserted. Closing either list is a product decision that has not been made.
- **The remaining reputation event types.** §11.5 names four bridge operations
  (apply, finalize, reverse, reconcile) but §11.6 specifies only
  `moderation.decision.finalized.v1`. The others are not invented here;
  `ReputationEventSchema` is a discriminated union of one so adding them is
  additive and consumers already switch on `type`.
- **Size limits.** §7.2.3 requires ingress to bound sizes and resource counts
  but states no numbers. `CONTRACT_LIMITS` declares them — generous enough not to
  reject real material, finite so nothing in the contract is unbounded. A tenant
  may be held to something tighter by quota.

## Tests

```bash
bun run --cwd packages/contracts test     # vitest, valid and invalid examples
bun run --cwd packages/contracts lint     # tsc for src/ and again for the tests
bun run --cwd packages/contracts build    # tsc → dist/ (CommonJS + .d.ts)
```

`src/__tests__/fixtures/` holds Appendix A, Appendix B, §5.8 and §10.7 verbatim,
and `reference-documents.test.ts` parses them. Where a reference document does
not validate as written, the test names the exact tokens responsible and the
suite asserts that nothing else in the document is refused.

Every negative test asserts the issue PATHS, not merely that parsing failed — a
negative example that fails for an unintended reason passes just as loudly as a
correct one, and then stops testing anything the day its rule is removed.
