# @oxyhq/crowdsource-express

Receiving CrowdSource webhooks, safely, in Express.

## The whole integration

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

No `express.raw`, no body-parser ordering, no secret plumbing, no signature code.
`event` is narrowed to `case.decided` and its `data.decision` is a typed
`Decision`.

## Installing

```bash
bun add @oxyhq/crowdsource-express @oxyhq/crowdsource-contracts express
```

`@oxyhq/crowdsource-contracts` is a **peer dependency**: `Decision` and every
event payload type are defined there, and two copies in one tree is a failure
with no diagnostic — `tsc` stays silent and every delivery answers 400
`malformed_event`, which reads as a signature problem. Declare it once and own
its version. `express` is a peer too (`>=4`).

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

`@oxyhq/crowdsource-testing`'s simulator delivers genuinely signed events, and
can deliver stale, forged and tampered ones on purpose. Asserting that your
receiver **refuses** those is the half of a webhook test that proves something.
