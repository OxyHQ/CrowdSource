# First-party service authority

Own services authenticate through shared Oxy workload middleware with audience
`oxy-service:6a6947b30fe72510b411252f`. Oxy centrally confirms live authority.
CrowdSource maps the verified application to its active stored tenant and active
organization. Neither an HTTP body nor an account header chooses that tenant.
The caller union carries `authority: first_party` without scopes, or `external`
with actual scopes. Own callers can use the application surface; privileged
moderation/staff authority remains separate. Audit ids include the exact Oxy
credential/workload handle. Oxy customer keys remain external even on an official
application; CrowdSource keys keep their existing scopes, expiry and revocation.

The product SDK factory delegates to `OxyServer.createServiceClient`. It accepts
an existing `oxy` client and optional verified requester proof. Requester-bound
clients are never shared across accounts and can be disposed after use. There
is no own credential-pair fallback. The external `new CrowdSource({serviceKey})`
interface remains available.

## Validation and release order

Source validation used local candidate Oxy core 7 / contracts 6, including Oxy
commit `4c4801e83`; temporary file dependencies were restored afterwards. This
source branch is not a deployment claim. Before publishing/deploying, update
registry dependency pins and the SDK peer range to the released compatible core,
release the changed factory contract, and migrate own callers using its removed
`oxyToken` option to `oxy`. The root client still supports an explicit manual
`oxyToken` provider for external compatibility; that does not establish own
authority at the receiver.

Verified: backend full suite 1540 tests in 93 files; final changed-boundary suite
17 tests including receiver signature/live authority, external narrowing and
revocation, tenant/organization isolation, privileged-operation denial, own SDK
HTTP transport and proof redaction. SDK unit/HTTP suites, outbox 140 tests in 18
files, and all 13 invariant mutations passed. Backend and SDK builds, production
and test type checks, and changed-file Biome checks passed. The central Oxy test
also traverses real SDK middleware, HTTP introspection and PostgreSQL authority;
product tests stub that central authority boundary while verifying signed JWTs.
