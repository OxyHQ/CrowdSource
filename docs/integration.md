# Integrating CrowdSource

Your first report and your first decision. The product target is **one
environment variable and the object being reported**, so this guide is short. If
it grows, that is a finding about the packages, not about the writing.

```bash
bun add @crowdsource.you/core @crowdsource.you/contracts
```

Two packages, and the second is a **peer dependency** of the first. Two copies of
contracts in one tree is a failure with no diagnostic — `tsc` stays silent and
every delivery answers `400`, which reads as a signature problem. Declare it once
and own its version.

`@crowdsource.you/core` is everything else: the API client is the root import,
and the webhook receiver, the application-side outbox and the test sandbox are
entry points of that same package.

| Import | Where it appears below | Extra install |
| --- | --- | --- |
| `@crowdsource.you/core` | [2. Send a report](#2-send-a-report) | — |
| `@crowdsource.you/core/express` | [4. Receive the decision](#4-receive-the-decision) | `express` |
| `@crowdsource.you/core/testing` | [5. Test the whole path](#5-test-the-whole-path-before-a-jury-has-ever-sat) | — |
| `@crowdsource.you/core/outbox` | not in this guide — the PostgreSQL application half, in [`packages/core/README.md`](../packages/core/README.md) | `express @oxy.so/db drizzle-orm postgres` |

**The line above is the whole install for an application that only files
reports.** `express`, `drizzle-orm`, `postgres`, `@oxy.so/db` and `@oxy.so/core`
are optional peers of `core`, reached only through `/express`, `/outbox` and —
for `@oxy.so/core` — [an Oxy service's own factory](#oxys-own-services-hold-no-key),
so importing the root pulls none of them into your graph.

> **Coming from `@oxy.so/crowdsource*`?**
>
> | Before | Now |
> | --- | --- |
> | `@oxy.so/crowdsource-contracts` | `@crowdsource.you/contracts` |
> | `@oxy.so/crowdsource` | `@crowdsource.you/core` |
> | `@oxy.so/crowdsource-express` | `@crowdsource.you/core/express` |
> | `@oxy.so/crowdsource-app` | `@crowdsource.you/core/outbox` |
> | `@oxy.so/crowdsource-app/postgres` | `@crowdsource.you/core/outbox/postgres` |
> | `@oxy.so/crowdsource-testing` | `@crowdsource.you/core/testing` |
>
> Same code, same version numbers, no export renamed — change the specifier and
> the import list is unchanged. The old names are not republished as shims, so a
> tree that still names one is a tree that never migrated, which is the point.

---

## 1. Get a service key

> **An Oxy service does not do this step at all.** Mention, Alia, Homiio and the
> rest hold no CrowdSource key: they present the Oxy service token their own
> infrastructure already issues, and CrowdSource resolves the tenant from the
> application it names. See [Oxy's own services](#oxys-own-services-hold-no-key)
> below. Everything from here to the end of this section is for a third party,
> which is who registration exists for.

```bash
CROWDSOURCE_SERVICE_KEY=app_…:cred_…:…
```

That is the only variable a report-sending integration configures. There is no
`CROWDSOURCE_APP_ID` and there never will be: the application a report belongs
to is read off the credential.

A key is issued by the developer console — an organization, an application
inside it, then a credential on that application:

| | |
| --- | --- |
| `POST /v1/console/organizations` | `{ name, slug }`. The creator becomes `owner`. |
| `POST /v1/console/organizations/{id}/applications` | `{ name }`. Needs `admin`. Starts at `sandbox` standing. |
| `POST /v1/console/applications/{id}/credentials` | `{ scopes, expiresInDays? }`. Needs `admin`. |

All three are **Oxy session** routes, not service-credential routes. For the
minimum integration ask for `crowdsource:reports:write`,
`crowdsource:cases:read` and `crowdsource:webhooks:manage`.

### Pending: the console UI is not deployed

`console.crowdsource.oxy.so` does not resolve today (`NXDOMAIN`, checked), and
the Cloudflare Worker job that would publish it is gated on the repository
variable `CROWDSOURCE_CONSOLE_WORKER == 'ready'`
(`.github/workflows/deploy-frontends.yml`) — deliberately, because the job creates
a Worker and claims a hostname in the zone carrying every live Oxy backend.

Until it is deployed, the three routes above are reachable only by a client that
already holds an Oxy session token. The API itself is live
(`https://api.crowdsource.oxy.so/health/ready` answers `200`).

### The service key has three parts, and the console shows two

This is the thing that will stop your first integration, so it is stated
plainly.

`POST /v1/console/applications/{id}/credentials` answers with

```json
{ "credentialId": "cred_…", "scopes": ["…"], "token": "cred_….<secret>", "createdAt": "…" }
```

and the console screen renders that `token` verbatim under the label **"service
key"** (`packages/console/app/(console)/applications/[applicationId]/credentials.tsx:84`,
`locales/en.json:323`).

`token` is the **HTTP bearer** — `<credentialId>.<secret>` — which is what
`Authorization: Bearer …` takes. `CROWDSOURCE_SERVICE_KEY` is a different
string: `applicationId:credentialId:secret`, colon-separated, three parts
(`packages/core/src/credential.ts`). Pasting the console's value into the
environment variable throws
`CrowdSourceConfigurationError: A CrowdSource service key is three
colon-separated parts (applicationId:credentialId:secret); this one has 1.`

Compose it yourself until the console does: take the application id from the
application page, then

```
<applicationId>:<the console's token with its "." replaced by ":">
```

**This is a defect, not a workflow.** `packages/core/src/credential.ts` carries a
"NOTE FOR THE CONSOLE" saying the issuing surface must show
`formatServiceKey(issued)`, and it does not; the issuing response does not even
carry `applicationId`. Fixing it is a change to that route and that screen.

The secret exists in that one response and nowhere else, ever. Only its SHA-256
is stored, so nothing — including this service — can recover it.

---

## 2. Send a report

```ts
import { CrowdSource } from '@crowdsource.you/core';

const crowdsource = new CrowdSource();

await crowdsource.reports.create({
  externalReportId: report.id,
  reportedBy: { oxyUserId: session.sub },
  subject: {
    externalId: post.id,
    type: 'social.post',
    author: { oxyUserId: post.authorId },
  },
  content: post.text,
  allegations: ['harassment.targeted_abuse'],
});
```

That is the whole surface for the common case. The client composes the Case
Envelope, its resource ids and relations, the `sha256` of every inline resource,
the pseudonymous principal refs, the identity-binding proof, the policy version,
the privacy terms and the `Idempotency-Key`. Every one of those can be
overridden per report and none of them has to be.

**Call this from a delivery worker draining your own outbox, never from the
request handler that answered the user.** A `2xx` from *your* application means
the report is stored locally with a durable retry path — not that a call to
CrowdSource succeeded. Every error this client throws carries `retryable`, which
is the only thing an outbox worker needs from it.

The response is `{ reportId, caseId, status, merged }`, and it means the report
is stored and durable rows exist for everything that happens next. It does not
mean a jury exists.

### The two rules that bite later

**Nothing you pass may vary between two deliveries of the same report.** Ingress
fingerprints the whole `{ externalReportId, envelope }` to detect a reused
external id with changed content, so an invented timestamp, a random id or an
unsorted list turns a legitimate retry into a permanent `409` — silently, days
later, appearing as moderation work stuck in your queue. This is why
`submittedAt` has no default: a default would be "now", and "now" differs
between two deliveries of one report.

**A `409` is not retryable.** It means the payload has to change. Everything
else your outbox should retry is already marked `retryable: true`.

### Attaching media — text-only reports work today; attachments may not

**Start with text.** `content` and `context` carry text resources and need
nothing but the report itself. Everything above works for a text-only
integration right now.

An attachment is a different matter, and this is a step to plan around rather
than to follow:

```ts
attachments: [{
  type: 'image',
  asset: {
    fileId: post.imageFileId,   // a bare Oxy file id — REQUIRED
    mimeType: 'image/jpeg',
    sha256: `sha256:${digestOf(bytes)}`,
    url: post.remoteImageUrl,   // optional provenance. Never fetched.
  },
}]
```

`AssetRefSchema` **requires** `fileId`, a bare Oxy file id
(`packages/contracts/src/resources.ts`). CrowdSource has no upload route of its
own, deliberately: the presigned design was superseded by the Oxy media
chokepoint before it was ever built, and the client's `src/uploads.ts` was
deleted. So a file id is the only way bytes reach a reviewer, and the only place
one comes from is the ecosystem's media service.

**Pending, and it decides whether attachments are usable at all:** nothing in
this repository establishes whether a **non-first-party** application can obtain
a `cloud.oxy.so` file id. If uploading is first-party only, an external adopter
can send text and cannot attach an image, and there is no fallback — `url` is a
provenance record that nothing ever resolves. That question is being answered
outside this repository; until it is, do not plan an attachment path, and do not
read the snippet above as an instruction.

**And a gap that holds either way:** nothing copies those bytes into storage
CrowdSource controls, and nothing verifies a fetched stream against the declared
`sha256`. A file id resolves to whatever `cloud.oxy.so` currently serves, so an
author who deletes an image removes it from the reviewer's screen mid-case.

---

## 3. Register the webhook your decisions arrive on

```ts
const endpoint = await crowdsource.webhookEndpoints.register({
  url: 'https://example.com/webhooks/crowdsource',
  eventTypes: ['case.decided'],
});

if (endpoint.secret) {
  // The ONLY time this value exists outside CrowdSource. Persist it now.
  await secrets.put('CROWDSOURCE_WEBHOOK_SECRET', endpoint.secret.value);
}
```

`secret` is present only when this call **minted** one. Re-registering an
existing URL returns the endpoint with no secret, which is what makes this safe
to run on every boot — it will never invalidate the secret your running process
is verifying with. The corollary is that re-registering cannot *recover* a
secret you failed to store; `rotateSecret` is what does.

Subscribe only to events that are actually published: `report.received`,
`case.decided`, `decision.corrected`, `appeal.created`, `appeal.decided`.
`case.created`, `case.escalated` and `case.closed` are accepted at registration
and produce nothing, because nothing publishes them yet — see
[the catalogue](./api/webhooks.md#event-catalogue).

---

## 4. Receive the decision

```bash
CROWDSOURCE_WEBHOOK_SECRET=…
```

```ts
import { crowdsourceWebhooks } from '@crowdsource.you/core/express';

app.post('/webhooks/crowdsource', crowdsourceWebhooks({
  on: {
    'case.decided': async (event) => {
      await moderationQueue.add(event.id, event.data);
    },
  },
}));
```

No `express.raw`, no body-parser ordering, no secret plumbing, no signature
code. `event` is narrowed to `case.decided` and `event.data.decision` is a typed
`Decision`.

The middleware reads the request stream itself. When something upstream already
consumed it — `express.json()` mounted globally, the normal shape of an Express
app — it **refuses** through your error handler rather than reconstructing the
bytes, because a signature verified over `JSON.stringify(req.body)` passes every
payload written by hand and fails on the first real delivery.

Answer quickly and queue the work. A refused delivery answers `401` and stays on
the sender's retry ladder; a `2xx` retires it as processed.

### What to do with a decision

`decision.outcome` is one of seven. Three of them are easy to get wrong:

- **`inconclusive` is its own outcome.** The jury did not agree. It is neither
  guilt nor innocence and must never be collapsed into `no_violation`.
- **`insufficient_context`** means nobody could judge on what you sent. Supply
  more and report again, or hold.
- **`escalated`** means the case was routed to a process that has not finished.

`decision.recommendedActions` are recommendations bound to resources. What you
do about them is yours: CrowdSource decides, your application enforces, and
§7.6 makes you responsible for recording what you did and why. **Make your
enforcement idempotent** — a redelivery landing on a second instance is not
deduplicated by the default in-process store.

CrowdSource never writes Oxy Trust and your application can never move a
reputation figure directly. You emit a report; CrowdSource emits a decision.

---

## 5. Test the whole path before a jury has ever sat

```ts
import { createCrowdSourceSandbox } from '@crowdsource.you/core/testing';

const sandbox = createCrowdSourceSandbox();
const crowdsource = new CrowdSource({
  serviceKey: sandbox.serviceKey,
  baseUrl: sandbox.baseUrl,
  fetch: sandbox.fetch,
});

process.env.CROWDSOURCE_WEBHOOK_SECRET = sandbox.webhookSecret;

const { caseId } = await crowdsource.reports.create({ /* … */ });
const decision = sandbox.decide(caseId, { outcome: 'violation' });
await sandbox.deliver('http://localhost:3000/webhooks/crowdsource', sandbox.eventFor(decision));
```

The report goes through the **real** client and the webhook is **genuinely
signed**, so the receiver under test is the receiver that will run in
production. Only the jury is stood in for.

Then assert your receiver says **no**: the simulator delivers stale, forged and
tampered events on purpose. A suite that only ever sends valid deliveries proves
the receiver can say yes.

---

## What you get on day one

A new application starts at `sandbox` standing (`modules/trust/quota.ts`), which
is 5,000 reports per day and 25 webhook endpoints — enough to build and
load-test a real integration. `trusted` raises that to 250,000 and is the only
standing at which a decision may reach Oxy Trust at all. `restricted` is zero
reports per day. Standing is not yours to change: it is a judgement made about
an application by somebody other than its owner, and only Trust & Safety moves
it.

With no policy set of your own you are evaluated under `crowdsource.baseline`
version `2026.07` — a pinned immutable version, never "whatever is current" —
over the universal taxonomy. See [the policy document](./policies/README.md) for
what that means and what a jury will actually be asked.

## Oxy's own services hold no key

A CrowdSource credential does two jobs: it proves the caller is who it claims,
and it names the tenant. For a third party both need a credential — nobody can
vouch for them, and registration is where trust starts.

For Oxy's own services the first job is already done, and done better. Under
[oxy ADR 0026][adr-0026] an official service proves what it *is* to Oxy using an
identity its infrastructure issues and rotates, with no secret anybody typed, and
receives a short-lived Oxy service token naming the application. Handing that
service a second, hand-issued CrowdSource key means a person re-stating something
the platform can already prove, and then keeping the restatement in a parameter
store forever.

So an Oxy service asks for a client and configures nothing at all:

```ts
import { crowdSourceForOxyService } from '@crowdsource.you/core';

const crowdsource = crowdSourceForOxyService();   // undefined where it cannot authenticate
```

That is the whole integration. The factory is built once per process and returns
the same client afterwards, it presents the Oxy service token
`@oxy.so/core`'s `getServiceToken()` already mints, and `CROWDSOURCE_SERVICE_KEY`
is neither needed nor read. `@oxy.so/core` is an **optional** peer dependency,
required lazily and only on this path — a third party never installs it, and
importing `@crowdsource.you/core` in a tree without it still works.

**`undefined` is a normal answer, not an error.** A process that can neither
attest a workload identity (ADR 0026) nor present an
`OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` pair cannot obtain a token, which
is exactly the state of a local checkout. A report filed there must still be
stored: the durable row is never gated on having somewhere to send it, and what
to do about a missing client is your decision, not the library's.

Three options, and nothing else — timeouts, retries, the idempotency key and the
envelope belong to the client and are not re-asked here:

| | |
| --- | --- |
| `oxyToken` | Used in place of the default provider. Set it when the token comes from an SDK instance of your own. |
| `baseUrl` | Defaults to the client's own. Set it only to point at a local backend. |
| `logger` | Defaults to none, which is silence rather than `console`. Given one, the factory resolves the tenant once in the background and reports it — a token minted for an Oxy application nobody bound authenticates nothing, and that is otherwise indistinguishable from "no reports yet". Nothing waits on it. |

`resetCrowdSourceForOxyService()` exists for tests. Production builds the client
once and keeps it for the process.

What is **not** relaxed:

- **The token must be Oxy's**, verified against Oxy's published keys by
  `@oxy.so/core`. A self-signed token is not a token.
- **The application must be bound.** A valid Oxy token for an application nobody
  linked to a CrowdSource tenant authenticates nothing. Binding is an explicit
  act — one row, no secret — and removing it is how a service is cut off.
- **The tenant still comes from the stored row**, never from the request, which
  is the same rule the credential path follows.
- **Privileged scopes stay unreachable.** A first-party service gets every scope
  an application credential may hold and nothing beyond it.

Because the token names an Oxy application rather than a CrowdSource one, a
client built this way has nothing to read its own `applicationId` off. It asks
`GET /v1/applications/me` once, on first use, and remembers the answer; the SDK
does this for you and `crowdsource.applicationId` is a promise in that case.

### Binding a service

One row, written by a one-off task inside the VPC — not a console click, because
nothing about it is a decision a person makes per service:

```bash
node dist/scripts/bootstrapFirstParty.js --name Mention --oxy-application-id <oxy application id>
```

It is idempotent: it reuses the `oxy` organization, reuses an existing binding,
and refuses only when the same Oxy application is already bound to a *different*
CrowdSource application — which would move a tenant's data out from under the
service that owns it.

[adr-0026]: https://github.com/OxyHQ/oxy/blob/main/docs/adr/0026-first-party-services-authenticate-as-workloads.md

## Environment reference

| Variable | Package | |
| --- | --- | --- |
| `CROWDSOURCE_SERVICE_KEY` | `@crowdsource.you/core` | Required for a third party. `applicationId:credentialId:secret`. An Oxy service sets `oxyToken` instead and configures nothing. |
| `CROWDSOURCE_BASE_URL` | `@crowdsource.you/core` | Optional. Overrides the host. `http://` is accepted for `localhost` and refused otherwise. |
| `OXY_SERVICE_API_KEY` | `@crowdsource.you/core` | Read only by `crowdSourceForOxyService()`, and only where the workload cannot attest. An Oxy service already sets this for the rest of its Oxy calls; nothing here is configured for CrowdSource. |
| `OXY_SERVICE_API_SECRET` | `@crowdsource.you/core` | Its secret half. Both or neither — one alone, or either left blank, reads as no credential. |
| `CROWDSOURCE_WEBHOOK_SECRET` | `@crowdsource.you/core/express` | The active signing secret. |
| `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS` | `@crowdsource.you/core/express` | The secret being retired. Set during a rotation overlap; clear it after `previousSecret.expiresAt`. |

**`@crowdsource.you/core` is server-side only.** A service credential is your whole
moderation stream; shipping one to a browser or a mobile bundle hands every user
of your application the ability to file reports as you, read your cases and
exhaust your quota. The package depends on `node:crypto` and does not build for
a browser, which is the intended outcome.

## Machine-checked claims

```docs-claims
service-key-env-var: CROWDSOURCE_SERVICE_KEY
base-url-env-var: CROWDSOURCE_BASE_URL
webhook-secret-env-var: CROWDSOURCE_WEBHOOK_SECRET
webhook-previous-secret-env-var: CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS
service-key-parts: 3
service-key-separator: :
bearer-token-separator: .
default-policy-set-id: crowdsource.baseline
default-policy-version: 2026.07
sandbox-reports-per-day: 5000
sandbox-webhook-endpoints: 25
trusted-reports-per-day: 250000
restricted-reports-per-day: 0
application-standings: sandbox, trusted, restricted
console-issued-credential-fields: credentialId, scopes, token, createdAt
```
