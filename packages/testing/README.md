# @oxyhq/crowdsource-testing

Fixtures, a webhook simulator and an in-process sandbox, so an application can
integrate against CrowdSource before a jury has ever sat.

## The full path, without real juries or real effects

`@oxyhq/crowdsource-contracts` is a **peer dependency** — the fixtures return
types defined there, and one copy per tree is the point. Install it alongside.

```ts
import { CrowdSource } from '@oxyhq/crowdsource';
import { createCrowdSourceSandbox } from '@oxyhq/crowdsource-testing';

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
import { WebhookSimulator, caseDecidedEventFixture } from '@oxyhq/crowdsource-testing';

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
