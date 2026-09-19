# @crowdsource.you/core

The CrowdSource integration, in one package. The TypeScript client for the
moderation API is the root import; the Express webhook receiver, the
transactional outbox and the test sandbox are entry points of the same package.

## The entry points

| Import | What it is | What it needs installed |
| --- | --- | --- |
| `@crowdsource.you/core` | The API client: compose a Case Envelope, file a report, read a case or a decision, register a webhook endpoint. | nothing beyond `@crowdsource.you/contracts` |
| `@crowdsource.you/core/express` | The webhook receiver: raw-body capture, HMAC verification, replay protection, typed events. | `express` |
| `@crowdsource.you/core/outbox` | The application half: a transactional outbox, delivery with retries, decision application and idempotent enforcement. | `express`, `@oxy.so/db`, `drizzle-orm`, `postgres` |
| `@crowdsource.you/core/outbox/postgres` | The PostgreSQL store behind `/outbox`: table definitions and the store itself. | as above |
| `@crowdsource.you/core/testing` | Fixtures, a webhook simulator and an in-process sandbox. | nothing beyond contracts |

**Importing the root pulls in none of `express`, `drizzle-orm`, `postgres` or
`@oxy.so/db`.** They are OPTIONAL peer dependencies, reached only through
`/express` and `/outbox`, so an application that files reports and nothing else
installs a client and a contracts package and stops there. That is the whole
reason the receiver and the outbox are subpaths rather than a second package:
there is no version of this package that can disagree with itself.

`@crowdsource.you/contracts` stays a package of its own, and is a **peer
dependency** here, so you declare it and own its version. That is deliberate:
every type these entry points return is defined there, and if two copies existed
in one tree the compiler would report nothing at all while every delivery failed
at runtime. One copy, chosen by you. It is also the half a React Native UI can
import without a server-only client landing in the phone bundle.

## What used to be called what

Five packages under `@oxy.so` became two under `@crowdsource.you`. The code did
not change and no export was renamed; the same version number carries the same
code under the new name.

| Before | Now |
| --- | --- |
| `@oxy.so/crowdsource-contracts` | `@crowdsource.you/contracts` |
| `@oxy.so/crowdsource` | `@crowdsource.you/core` |
| `@oxy.so/crowdsource-express` | `@crowdsource.you/core/express` |
| `@oxy.so/crowdsource-app` | `@crowdsource.you/core/outbox` |
| `@oxy.so/crowdsource-app/postgres` | `@crowdsource.you/core/outbox/postgres` |
| `@oxy.so/crowdsource-testing` | `@crowdsource.you/core/testing` |

The old names are not published as shims and never will be: six abandoned
packages on the registry cost every future reader more than six migration pull
requests cost us once.

## Installing

```bash
bun add @crowdsource.you/core @crowdsource.you/contracts
```

Add `express` if you receive webhooks, and `@oxy.so/db drizzle-orm postgres` if
you use the outbox.

## The client

## The whole integration

```bash
CROWDSOURCE_SERVICE_KEY=app_…:csk_…:…
```

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
| `CROWDSOURCE_SERVICE_KEY` | Required for a third party. The one value an integration configures. An Oxy service sets `oxyToken` instead and configures nothing — see "Oxy's own services" below. |
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

## Oxy's own services

Mention, Alia, Homiio and the rest hold no service key. They present the Oxy
service token their own infrastructure already issues, and CrowdSource resolves
the tenant from the Oxy application it names:

```ts
const crowdsource = new CrowdSource({
  oxyToken: () => oxyServices.getServiceToken(),
});
```

`oxyToken` is asked once per request attempt, so a cached token refreshed on
expiry is the expected shape — which is what `getServiceToken()` returns. With it
set, `CROWDSOURCE_SERVICE_KEY` is neither needed nor read, and there is nothing
to rotate, store or leak.

The token names an *Oxy* application, so there is no `applicationId` to read off
it. The client asks `GET /v1/applications/me` once on first use and remembers the
answer, which is why `applicationId` is a promise on this path and a string on
the other.

This is not a way around registration: the Oxy application must be bound to a
CrowdSource one first, and an unbound token authenticates nothing. Third parties
keep the service key — they run where Oxy cannot vouch for them.

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
`@crowdsource.you/core/express`. Tell CrowdSource where to deliver, and store the
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

---

# `@crowdsource.you/core/express`

Receiving CrowdSource webhooks, safely, in Express.

## The whole integration

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

No `express.raw`, no body-parser ordering, no secret plumbing, no signature code.
`event` is narrowed to `case.decided` and its `data.decision` is a typed
`Decision`.

`express` is an optional peer (`>=4.18.0 <6`) — optional because a consumer that
only files reports imports the root and never reaches this entry point, and
installing a web framework to do that would be absurd. Reaching `/express`
without `express` installed fails at import with a module-not-found, which is the
loud version of that trade.

## Where the secret comes from

`CROWDSOURCE_WEBHOOK_SECRET` is minted **once**, by the response to
`crowdsource.webhookEndpoints.register(...)` — the call that tells CrowdSource
where to deliver:

```ts
const endpoint = await crowdsource.webhookEndpoints.register({
  url: 'https://example.com/webhooks/crowdsource',
  eventTypes: ['case.decided'],
});
endpoint.secret?.value; // store it now; nothing returns it again
```

Re-registering the same URL mints nothing, so it cannot recover a secret you
dropped — `crowdsource.webhookEndpoints.rotateSecret()` is what does.

## Environment

| Variable | |
| --- | --- |
| `CROWDSOURCE_WEBHOOK_SECRET` | The active signing secret. Also settable as the `secret` option. |
| `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS` | The secret being retired. Set it during a rotation overlap — both are accepted while it is present, which is what makes a rotation drop nothing. Clear it after `previousSecret.expiresAt`. Also settable as the `previousSecret` option. |

## Why there is no raw-body step for you to get wrong

The likeliest way to ship a broken webhook receiver is to verify a signature over
`JSON.stringify(req.body)`. It passes every payload a developer writes by hand
and fails on the first real delivery whose formatting differs — or, worse,
accepts a forged body that happens to re-serialise identically.

So this middleware reads the request stream itself, and when something upstream
already consumed it — `express.json()` mounted globally, which is the normal
shape of an Express app — it **refuses** through your error handler instead of
reconstructing the bytes. `express.raw()` ahead of it and the
`express.json({ verify })` idiom are both recognised and supported.

## What it guarantees

| | |
| --- | --- |
| Signature | HMAC-SHA256 over `timestamp + "." + rawBody`, compared with `timingSafeEqual` (§10.8) |
| Freshness | ±5 minutes, in **both** directions |
| Replay | one claim per event id; a handler that throws releases it so §10.9's retry still works |
| Rotation | `previousSecret` is accepted alongside the active one, so a rotation drops nothing |
| Forward compatibility | an event type this integration does not handle is acknowledged and ignored (§10.11) |
| Privacy | `onRejected` gets the reason and nothing else — never a body, header or signature |

A refused delivery answers 401 and never 2xx, so it stays on the sender's retry
schedule rather than being retired as processed.

## Deduplication across instances

The default store is in-process. Two instances behind a load balancer each keep
their own, so a redelivery landing on the other instance is not deduplicated.
That is usually fine — §7.6 makes the application responsible for recording what
it did about a decision, so enforcement should be idempotent anyway. If yours is
not, pass a shared `store` (Redis, your own database) implementing
`claim`/`release`.

## Testing it

`@crowdsource.you/core/testing`'s simulator delivers genuinely signed events, and
can deliver stale, forged and tampered ones on purpose. Asserting that your
receiver **refuses** those is the half of a webhook test that proves something.

---

# `@crowdsource.you/core/outbox`

The application-side CrowdSource integration for PostgreSQL applications. It
stores a report and its outbox event atomically, delivers reports with retries,
verifies signed webhook bodies, applies revisions in order and records reversible
enforcement exactly once.

This entry point is PostgreSQL-only. The former `/mongoose` entry point was
removed before the scope rename; the package does not install, import or publish
a MongoDB driver.

## Install

```sh
bun add @crowdsource.you/core @crowdsource.you/contracts \
  @oxy.so/db drizzle-orm postgres express
```

The four runtime peers are optional on the package, so this is the line that
makes them real. A consumer that never imports `/outbox` installs none of them.

## Schema and store

The adopting application owns its report table. Spread the supplied moderation
columns into that table and use the three package-owned tables for the outbox,
webhook event ledger and enforcement ledger.

```ts
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { DATABASE_CASING } from '@oxy.so/db';
import {
  moderationReportColumns,
  moderationReportTableExtras,
  moderationTables,
  postgresModerationStore,
} from '@crowdsource.you/core/outbox/postgres';

const REPORT_MODERATION = {
  reportedTypes: ['listing', 'review'],
  categories: ['spam', 'harassment'],
} as const;

const reports = pgTable(
  'reports',
  {
    ...moderationReportColumns(REPORT_MODERATION),
    legacyStatus: text('legacy_status'),
  },
  moderationReportTableExtras(REPORT_MODERATION),
);

const moderation = moderationTables({
  enforcementActions: ['restrict', 'restore', 'review', 'none'] as const,
});

const client = postgres(process.env.DATABASE_URL ?? '', { max: 10 });
const db = drizzle(client, {
  casing: DATABASE_CASING,
  schema: { reports, ...moderation },
});

const store = postgresModerationStore({
  db,
  reportTable: reports,
  tables: moderation,
});
```

Generate and apply DDL from the adopter's complete Drizzle schema before the
first write. `store.ensureSchema()` validates the required indexes and checks; it
does not replace migrations.

## Integration

```ts
import express from 'express';
import { createModerationIntegration } from '@crowdsource.you/core/outbox';

const integration = createModerationIntegration({
  store,
  crowdSource: {
    enabled: true,
    serviceKey: process.env.CROWDSOURCE_SERVICE_KEY,
    webhookSecret: process.env.CROWDSOURCE_WEBHOOK_SECRET,
    enforcementMode: 'observe',
  },
  subjects: [listingSubjectProvider(), reviewSubjectProvider()],
  taxonomy: { version: '2026.07', allegationsFor },
  enforcement: commerceEnforcement,
  logger,
});

await store.ensureSchema();

const app = express();
app.use('/webhooks', integration.webhookRouter());
app.use(express.json());
integration.dispatcher.start();
```

Mount the webhook router before `express.json()`: CrowdSource verifies the exact
bytes received. The router refuses a request whose body was already parsed.

## Required guarantees

- Every application-domain mutation and its outbox row use the same Drizzle
  transaction. A pool handle is rejected by the outbox store.
- Delivery and webhook event IDs are idempotency keys. Retrying does not create a
  second row or a second enforcement effect.
- Claims use `FOR UPDATE SKIP LOCKED` and bounded leases, so concurrent workers do
  not process one row twice or wait behind a locked row.
- PostgreSQL does not provide TTL indexes. Schedule sweeps for
  `moderationExpirySweepTargets()` and retain the supplied expiry indexes.
- Never log report content, webhook secrets or provider credentials.

## Migrating an adopter's data

Do not upgrade first. The repository runbook
[`../../docs/runbooks/crowdsource-app-postgres-cutover.md`](../../docs/runbooks/crowdsource-app-postgres-cutover.md)
defines the fail-closed sequence and evidence manifest. The important boundary
is simple: export with the old application release, import into a separately
named empty PostgreSQL database, reconcile counts and canonical SHA-256 digests,
then deploy the PostgreSQL application release. This package cannot infer an
adopter's custom report collection, primary key or extra columns, so it does not
ship a data copier that guesses them.

---

# `@crowdsource.you/core/testing`

Fixtures, a webhook simulator and an in-process sandbox, so an application can
integrate against CrowdSource before a jury has ever sat.

## The full path, without real juries or real effects

```ts
import { CrowdSource } from '@crowdsource.you/core';
import { createCrowdSourceSandbox } from '@crowdsource.you/core/testing';

const sandbox = createCrowdSourceSandbox();
const crowdsource = new CrowdSource({
  serviceKey: sandbox.serviceKey,
  baseUrl: sandbox.baseUrl,
  fetch: sandbox.fetch,
});

// The sandbox signs with its OWN secret. Point the receiver at it, or every
// delivery below is refused with `signature_mismatch` and the test looks broken.
process.env.CROWDSOURCE_WEBHOOK_SECRET = sandbox.webhookSecret;

const { caseId } = await crowdsource.reports.create({ /* … */ });

const decision = sandbox.decide(caseId, { outcome: 'violation' });
const event = sandbox.eventFor(decision);
await sandbox.deliver('http://localhost:3000/webhooks/crowdsource', event);
```

`eventFor` mints a fresh event id on every call, so hold the event if you mean to
test a REDELIVERY — calling it twice is two different events, and a receiver is
right to handle both.

The report goes through the **real** client — real envelope composition, real
idempotency key, real error mapping — and the webhook that comes back is
**genuinely signed**, so the receiver under test is the receiver that will run in
production. Only the jury is stood in for.

## Asserting your receiver says no

```ts
import { WebhookSimulator, caseDecidedEventFixture } from '@crowdsource.you/core/testing';

const simulator = new WebhookSimulator({ secret, url });

await simulator.deliver(caseDecidedEventFixture());                       // 200
await simulator.deliver(caseDecidedEventFixture(), { expired: true });    // must be refused
await simulator.deliver(caseDecidedEventFixture(), { wrongSecret: 'x' }); // must be refused
await simulator.deliver(caseDecidedEventFixture(), { tamperedBody: '…' });// must be refused
```

A suite that only ever sends valid deliveries proves the receiver can say yes.

## What the sandbox actually enforces

The rules an integration's code depends on, faithfully: `applicationId` from the
credential, an idempotency key that returns the same `reportId`, a 409 for a
reused `externalReportId` with a changed body, §7.3's "two reports about the same
version of the same content are one case", and a decision that supersedes rather
than edits.

It is **not** the service. It holds nothing between processes, it answers 404 for
routes the deployed backend does not serve either, and where it and the backend
disagree the backend is right.

## Rules

- Fixtures are synthetic. Real reported material, real evidence and real reviewer
  identities never ship in a test package.
- Every fixture is validated against the published contracts as it is built. One
  that no longer validates is a failure, not something to loosen: it is how an
  integrator learns a contract moved.

---

## Verification

```sh
bun run --cwd packages/core lint
bun run --cwd packages/core build
CROWDSOURCE_APP_TEST_POSTGRES_URL=postgres://... \
  bun run --cwd packages/core test
bun run check:outbox-postgres-only
```

`CROWDSOURCE_APP_TEST_POSTGRES_URL` keeps the name it had when the outbox was its
own package: only the `/outbox` suite reads it, it is the same server the compose
file starts, and a rename would silently strand an exported value in somebody's
shell. The storage behaviour suite runs against PostgreSQL 17, including
transaction rollback, concurrent claims, idempotent enqueue, revision order and
enforcement reversal. The invariant mutation runner removes each load-bearing
guard and requires the named test to fail.
