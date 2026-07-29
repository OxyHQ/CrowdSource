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
