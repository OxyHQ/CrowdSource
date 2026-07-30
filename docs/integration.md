# Integrating CrowdSource

Your first report and your first decision. The product target is **one
environment variable and the object being reported**, so this guide is short. If
it grows, that is a finding about the packages, not about the writing.

```bash
bun add @oxyhq/crowdsource @oxyhq/crowdsource-contracts
```

`@oxyhq/crowdsource-contracts` is a **peer dependency** of every published
package here. Two copies of it in one tree is a failure with no diagnostic —
`tsc` stays silent and every delivery answers `400`, which reads as a signature
problem. Declare it once and own its version.

---

## 1. Get a service key

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
the Cloudflare Pages job that would publish it is gated on the repository
variable `CROWDSOURCE_CONSOLE_PAGES == 'ready'`
(`.github/workflows/deploy-frontends.yml:232`) — deliberately, because the job
creates a project and writes DNS into the zone carrying every live Oxy backend.

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
(`packages/sdk/src/credential.ts`). Pasting the console's value into the
environment variable throws
`CrowdSourceConfigurationError: A CrowdSource service key is three
colon-separated parts (applicationId:credentialId:secret); this one has 1.`

Compose it yourself until the console does: take the application id from the
application page, then

```
<applicationId>:<the console's token with its "." replaced by ":">
```

**This is a defect, not a workflow.** `packages/sdk/src/credential.ts` carries a
"NOTE FOR THE CONSOLE" saying the issuing surface must show
`formatServiceKey(issued)`, and it does not; the issuing response does not even
carry `applicationId`. Fixing it is a change to that route and that screen.

The secret exists in that one response and nowhere else, ever. Only its SHA-256
is stored, so nothing — including this service — can recover it.

---

## 2. Send a report

```ts
import { CrowdSource } from '@oxyhq/crowdsource';

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

### Attaching media

Upload the bytes through the Oxy media chokepoint with your own Oxy
credentials, then pass the **bare file id**:

```ts
attachments: [{
  type: 'image',
  asset: {
    fileId: post.imageFileId,
    mimeType: 'image/jpeg',
    sha256: `sha256:${digestOf(bytes)}`,
    url: post.remoteImageUrl,   // optional provenance. Never fetched.
  },
}]
```

CrowdSource has no upload route of its own, deliberately. `asset.sha256` is
required, so you already hold the bytes you are reporting; putting them through
the chokepoint asks for nothing new.

**Known gap:** nothing copies those bytes into storage CrowdSource controls, so
a file id resolves to whatever `cloud.oxy.so` currently serves. An author who
deletes an image removes it from the reviewer's screen mid-case.

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
import { crowdsourceWebhooks } from '@oxyhq/crowdsource-express';

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
import { createCrowdSourceSandbox } from '@oxyhq/crowdsource-testing';

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

## Environment reference

| Variable | Package | |
| --- | --- | --- |
| `CROWDSOURCE_SERVICE_KEY` | `@oxyhq/crowdsource` | Required. `applicationId:credentialId:secret`. |
| `CROWDSOURCE_BASE_URL` | `@oxyhq/crowdsource` | Optional. Overrides the host. `http://` is accepted for `localhost` and refused otherwise. |
| `CROWDSOURCE_WEBHOOK_SECRET` | `@oxyhq/crowdsource-express` | The active signing secret. |
| `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS` | `@oxyhq/crowdsource-express` | The secret being retired. Set during a rotation overlap; clear it after `previousSecret.expiresAt`. |

**`@oxyhq/crowdsource` is server-side only.** A service credential is your whole
moderation stream; shipping one to a browser or a mobile bundle hands every user
of your application the ability to file reports as you, read your cases and
exhaust your quota. The package depends on `node:crypto` and does not build for
a browser, which is the intended outcome.
