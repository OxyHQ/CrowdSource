# @oxyhq/crowdsource

The TypeScript client for the CrowdSource moderation API.

## Installing

```bash
bun add @oxyhq/crowdsource @oxyhq/crowdsource-contracts
```

`@oxyhq/crowdsource-contracts` is a **peer dependency**, so you declare it and
own its version. That is deliberate: every type this client returns is defined
there, and if two copies of it existed in one tree the compiler would report
nothing at all while parsing failed at runtime. One copy, chosen by you.

## The whole integration

```bash
CROWDSOURCE_SERVICE_KEY=app_…:csk_…:…
```

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

One environment variable and the object being reported. That is the whole
surface for the common case.

## What the client fills in, so you do not have to

| Composed for you | From |
| --- | --- |
| `applicationId` | the service key — there is no option to pass one |
| the Case Envelope, its resource ids and its relations | the subject, content, attachments and context you described |
| `sha256` on every inline resource | the content itself |
| principal bindings and their pseudonymous refs | the identities you named, hashed |
| the identity binding proof (§11.14) | the Oxy `sub` — Sign in with Oxy already produced it |
| `policy` | `DEFAULT_POLICY`, a pinned immutable version |
| `privacy` | 30 days (§13.6), and §7.5's community-review restrictions |
| `Idempotency-Key` | `report.<externalReportId>` (Appendix D) |
| base URL, timeouts, bounded retries | defaults |

Anything in that table can be overridden per report. Nothing in it has to be.

## Environment

| Variable | |
| --- | --- |
| `CROWDSOURCE_SERVICE_KEY` | Required. The one value an integration configures. |
| `CROWDSOURCE_BASE_URL` | Optional. Overrides the service host — set it only to point at a local backend. `http://` is accepted for `localhost` and refused for anything else, because a service credential sent in clear is a credential you have to rotate. |

There is **no** `CROWDSOURCE_APP_ID` and there never will be. The application a
report belongs to is read off the credential; see "The service key" below.

## Rules

- **A report is delivered from your own outbox, never from a request handler.**
  §7.1: a 2xx from your application means the report is stored locally with a
  durable retry path — not that a call to CrowdSource succeeded. Every error this
  client throws carries `retryable`, which is the only thing an outbox worker
  needs from it.
- **`applicationId` comes from the credential.** It is not an option on the
  client, not a field on a report, and not something an envelope input can
  carry.
- **Re-delivering the same report is safe.** The same `externalReportId` with a
  *different* body is a 409, is not retryable, and means the payload has to
  change.
- **Evidence never gets a durable URL from CrowdSource.** An asset carries a bare
  Oxy `fileId`; no method here returns a link to bytes (§12.10). `asset.url` is
  provenance only and is never fetched.
- **Server-side only.** A service credential is your whole moderation stream;
  this package depends on `node:crypto` and must never reach a browser or a
  mobile bundle.

## The service key

CrowdSource issues three values together — the application, the credential id
and the secret. The client takes them as one opaque string,
`applicationId:credentialId:secret`, so an integration configures one variable
and the client reads the application off the credential rather than being told
it. `formatServiceKey()` builds that string from what
`issueApplicationCredential` returns.

## Attaching an image, a video or a document

Upload the bytes through the **Oxy media chokepoint** with your application's own
Oxy credentials, then pass the bare file id:

```ts
await crowdsource.reports.create({
  externalReportId: report.id,
  subject: { externalId: post.id, type: 'social.post' },
  content: post.text,
  attachments: [
    {
      type: 'image',
      asset: {
        fileId: post.imageFileId,          // bare Oxy file id — never a URL
        mimeType: 'image/jpeg',
        sha256: `sha256:${digestOf(bytes)}`,
        url: post.remoteImageUrl,          // optional provenance. Never fetched.
      },
    },
  ],
  allegations: ['harassment.targeted_abuse'],
});
```

**CrowdSource has no upload route of its own, and that is deliberate.** Evidence
lives behind the one Oxy media chokepoint the whole ecosystem uses, so there is no
second place for bytes to be, no presigned URL to leak and no bucket to configure.
Earlier releases shipped an `uploads` client for a presigned flow that was
superseded before it was ever built; it is gone.

`asset.url` is a **provenance record and never a fetch target**. A federated
post's image genuinely lives elsewhere, so recording where it was found is useful
— but nothing resolves it. Fetching it would tell that host exactly when its
content is under review, and would deliver live bytes instead of the version §5.6
requires the case to pin.

Note `asset.sha256` is required, so an application always already holds the bytes
it is reporting. Putting them through the chokepoint asks for nothing new.

`reports.create`, `reports.get`, `cases.get`, `decisions.get`,
`webhookEndpoints.register` and `webhookEndpoints.rotateSecret` are all served.

## Registering the webhook your decisions arrive on

A decision reaches an application over a webhook, not by polling — see
`@oxyhq/crowdsource-express`. Tell CrowdSource where to deliver, and store the
secret it mints:

```ts
const endpoint = await crowdsource.webhookEndpoints.register({
  url: 'https://example.com/webhooks/crowdsource',
  eventTypes: ['case.decided'],
});

if (endpoint.secret) {
  // The ONLY time this value exists outside CrowdSource. Persist it now, as
  // CROWDSOURCE_WEBHOOK_SECRET, before doing anything else.
  await secrets.put('CROWDSOURCE_WEBHOOK_SECRET', endpoint.secret.value);
}
```

`secret` is present only when this call minted one. Re-registering an existing
URL returns the endpoint with **no** secret, which is what makes this safe to run
on every boot — it will never invalidate the secret your running process is
verifying with. The corollary is that re-registering cannot *recover* a secret
you failed to store:

```ts
const rotated = await crowdsource.webhookEndpoints.rotateSecret(endpoint.webhookEndpointId, {
  overlapSeconds: 28_800, // 0 for an immediate cutover, which is what a leak needs
});
// Serve both until rotated.previousSecret.expiresAt and no delivery is dropped.
```

The credential needs the `crowdsource:webhooks:manage` scope. There is no list,
read-back or delete route — the API serves exactly these two — so an integration
cannot currently enumerate what it has registered.
