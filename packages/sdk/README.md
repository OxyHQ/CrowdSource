# @oxyhq/crowdsource

The TypeScript client for the CrowdSource moderation API.

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
- **Evidence never gets a durable URL.** `uploads.upload()` takes bytes and
  returns an `uploadId` and a digest. There is no method that returns a link
  (§12.10).
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

## Not usable yet

- `uploads.upload()` implements §10.2's presigned upload and completion. **The
  backend does not serve `/v1/uploads` yet**, so it answers 404 today. Report
  inline content and attachments instead; nothing else in this client depends on
  it.

`reports.create`, `reports.get`, `cases.get` and `decisions.get` are all served.

## Registering the webhook your decisions arrive on

A decision reaches an application over a webhook, not by polling — see
`@oxyhq/crowdsource-express`. Registering the endpoint that receives it, and
capturing the signing secret it returns, is **not on this client yet**: the API
serves `POST /v1/webhook-endpoints` and
`POST /v1/webhook-endpoints/{id}/rotate-secret`, and until this package wraps
them, call them with the bearer token in your service key —
`<credentialId>.<secret>`, the second and third colon-separated parts, which
`parseServiceKey()` returns as `bearerToken`.

```ts
import { parseServiceKey } from '@oxyhq/crowdsource';

const { bearerToken } = parseServiceKey(process.env.CROWDSOURCE_SERVICE_KEY ?? '');

const registered = await fetch('https://api.crowdsource.oxy.so/v1/webhook-endpoints', {
  method: 'POST',
  headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://example.com/webhooks/crowdsource', eventTypes: ['case.decided'] }),
});
```

The secret is in that response and **in no other response, ever**. Store it as
`CROWDSOURCE_WEBHOOK_SECRET` before you lose it; re-registering the same URL
returns 200 and mints no new secret, so a deploy script that re-registers on
every boot cannot recover one it dropped — that is what
`rotate-secret` is for. The credential needs the `crowdsource:webhooks:manage`
scope.
