# `@oxyhq/crowdsource-app`

The application half of a CrowdSource integration.

Every application that adopts CrowdSource has to solve the same six problems, and
none of them has anything to do with what that application's objects are:

1. store a report and its promise of delivery atomically;
2. deliver it, with retries, backoff and a dead-letter path;
3. receive signed decisions without a body parser destroying the signature;
4. deduplicate redeliveries across several tasks behind one load balancer;
5. apply a decision without a stale revision overwriting a fresh one;
6. carry out consequences exactly once, and reversibly.

All of that is in here. You supply four things.

```bash
bun add @oxyhq/crowdsource-app @oxyhq/crowdsource-contracts
```

`@oxyhq/crowdsource-contracts` is a **peer** dependency, and bun installs a
missing peer silently with no warning at all — so install it explicitly. Two
copies of contracts produce no type error and no diagnostic; the symptom is every
webhook answering `400 malformed_event`, which reads as a delivery problem.
`mongoose` and `express` are peers too.

---

## What you supply

### 1. Subject providers — your nouns, as universal material

```ts
import type { ModerationSubjectProvider } from '@oxyhq/crowdsource-app';

export function listingSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: 'listing',          // your own name for the noun
    subjectType: 'commerce.listing',  // the universal type
    async snapshot(reportedId) {
      const listing = await Listing.findById(reportedId).lean();
      if (!listing) return null;      // deleted: ordinary, not a failure
      return {
        subject: {
          externalId: String(listing._id),
          type: 'commerce.listing',
          permalink: `${WEB_ORIGIN}/l/${listing._id}`,
          author: { oxyUserId: listing.sellerId },
        },
        content: { type: 'text', data: { text: listing.description } },
      };
    },
  };
}
```

A provider returns a **description**, never an envelope. `@oxyhq/crowdsource`
composes the Case Envelope from it — resource ids, digests, relations,
pseudonymous principal refs, the identity binding proof, the pinned policy
version and the idempotency key — and the case dedup key is computed over exactly
those derived values. An application that composed its own envelope would be the
reason two reporters about one listing opened two cases, and "one penalty per
incident" would fail in production with nothing failing in a test.

A provider is pure translation with reads. It does not decide whether to deliver,
what the allegation is, or what happens to the report.

**A reported type with no provider is still accepted and still stored** — at
`localStatus: 'received'`, with the reason recorded — it simply never leaves. The
registry is not an admission gate, and making it one breaks your existing report
surfaces on the day you adopt CrowdSource. Adopt one subject type at a time.

### 2. A taxonomy — your categories, as allegations

```ts
const taxonomy = {
  version: '2026.07',
  allegationsFor(categories: readonly string[]) {
    const codes = new Set<TaxonomyCode>();
    for (const category of categories) {
      codes.add(CATEGORY_TO_ALLEGATION[category] ?? 'other.unclassifiable');
    }
    return Array.from(codes).sort();   // SORT — see below
  },
};
```

Codes are **allegations**: what is claimed, never what is true. A jury classifies
the material itself and may confirm a different code entirely.

Two hard requirements. **Sort the result**: ingress fingerprints the whole
envelope to detect "same external id, different body", so an order that depended
on how a client happened to send its categories turns a legitimate outbox retry
into a permanent 409 — silently, days later, as a report stuck in a queue. **Never
return empty**: a report with no allegation is not a report, and this package
dead-letters rather than substituting a code no reporter chose.

Version it, and bump the version in the same change that alters a row: a decision
records the policy version it was decided under, and this mapping is upstream of
that.

### 3. Enforcement — what you can do, and how to undo it

You write tables and one `apply`. The algorithm is not yours to write.

```ts
const enforcement: ModerationEnforcementConfig<CommerceAction> = {
  actions: ['delist', 'relist', 'flag', 'unflag', 'review', 'none'],
  noneAction: 'none',
  reviewAction: 'review',
  restoreAction: 'relist',
  recommendationToAction: { remove: 'delist', hide: 'delist', label: 'flag', restore: 'relist', /* … */ },
  severityFallback: { critical: 'review', high: 'delist', medium: 'flag', low: 'review' },
  absorb: { delist: ['flag', 'none', 'relist'] },
  precedence: ['delist', 'relist', 'flag', 'unflag', 'review', 'none'],
  reversibleActions: ['relist', 'unflag'],
  reverses: { relist: 'delist', unflag: 'flag' },

  async apply({ action, subject, previousState }) {
    // …change your own state, or say why there was nothing to change
    return { changed: true, previousState: { status: listing.status } };
  },
};
```

**Declare `restoreAction` if you have one.** A correction is a new revision whose
outcome is `no_violation` and whose recommendation is frequently `no_action` —
which means "take no NEW action", not "leave what you already did in place". Map
that straight through and the listing an earlier revision removed stays removed
forever: the appeal succeeded, the case says the content was fine, and nothing
ever puts it back. No error, no log line, no failing test. Declaring
`restoreAction` makes `no_violation` always plan the restore; the executor records
"there was nothing to undo" when that is the case, which is evidence rather than a
silent no-op.

`{ changed: false, reason }` is **not** a failure — the object is already gone, or
there was no restriction to undo. It is recorded with its reason, which is how "we
checked and there was nothing to do" stays distinguishable from "we never looked".
Throw only for a real failure; the idempotency claim is then released so a retry
can try again.

`previousState` is yours and opaque to this package: it is written on the
enforcement row when an action is applied, and handed back to `apply` when a later
revision reverses it (per `reverses`). Keep it small, flat and JSON-serialisable,
and never put reported material in it.

Three modes. `observe` runs the plan, the claim and the audit row and skips only
the effect, so it is a real rehearsal rather than a log line. `manual` additionally
applies `reversibleActions` — the actions that give something back, because
holding those behind a human means a wrongly-removed listing stays removed while
somebody reads a queue. `automatic` applies everything.

### 4. Your report model

Compose your own schema. Your collection, your enums, your extra fields.

```ts
import { applyModerationReportIndexes, moderationReportSchemaFields } from '@oxyhq/crowdsource-app';

const ReportSchema = new Schema<IReport>(
  {
    ...moderationReportSchemaFields({
      reportedTypes: Object.values(ReportedType),
      categories: Object.values(ReportCategory),
    }),
    // …your own fields
  },
  { timestamps: true },
);
applyModerationReportIndexes(ReportSchema);

export const Report = connection.model<IReport>('Report', ReportSchema);
```

`localStatus` is the axis every query in this package uses, and it is about
delivery rather than any verdict:

| value | meaning |
| --- | --- |
| `received` | stored, and never going anywhere: the type has no provider. Deliberate, not a failure. |
| `queued` | stored with a durable delivery event, in one transaction. |
| `submitted` | CrowdSource has it; a case exists. |
| `delivery_failed` | the last attempt failed; the outbox is retrying or has dead-lettered it. |
| `closed` | a final or corrected decision was applied, or the material is gone. |

Already have a verdict field from before you adopted CrowdSource? Supply
`reportDecisionExtraFields(decision)` and derive it **there**, from the decision,
and nowhere else. Two status fields maintained by two call sites is how they
drift. A new application needs none of this.

---

## Wiring it

```ts
import { createModerationIntegration } from '@oxyhq/crowdsource-app';

export const moderation = createModerationIntegration({
  connection,                        // your mongoose.Connection
  crowdSource: {
    enabled: config.crowdSource.enabled,
    serviceKey: config.crowdSource.serviceKey,
    webhookSecret: config.crowdSource.webhookSecret,
    enforcementMode: 'observe',
  },
  reportModel: Report,
  subjects: [listingSubjectProvider(), reviewSubjectProvider()],
  taxonomy,
  enforcement,
  logger,
});
```

In your HTTP app — **the mount order is part of the correctness**:

```ts
// BEFORE express.json(). The signature covers the bytes that arrived, and a
// parser consumes them.
app.use('/webhooks', moderation.webhookRouter());
app.use(express.json());
```

In your server (not your app builder):

```ts
moderation.dispatcher.start();          // safe on EVERY task
if (isLeader) moderation.reconciliationJob.start();   // leader-gated
```

The dispatcher is not leader-gated on purpose: every event is claimed under a
lease with an owner check, so N tasks share the work, and a task dying
mid-delivery has its lease expire and its event reclaimed. The reconciliation
sweep scans the whole collection and belongs to one task.

And on your report route:

```ts
const { report } = await moderation.createReport({
  reporter: oxyUserId,
  reportedType: 'listing',
  reportedId: listingId,
  categories: ['spam'],
  details,
});
```

`enabled: false` is a normal state — a local checkout, or any deployment before
rollout. Reports are still stored **and still get their delivery events**, so
turning the flag on delivers the backlog instead of stranding it. Only the
dispatcher is gated.

---

## The two invariants

Both are enforced here rather than documented, because both fail silently and
neither shows up in a test that only asserts the happy path.

**Nothing can be enqueued that is not already recorded in the outbox, in the same
transaction.** A job is a hint that work is pending, never the only evidence it
exists. The only writer of the outbox collection takes a required `ClientSession`
and throws `ModerationOutboxTransactionError` when that session is not actually
in a transaction — because a required parameter is satisfied by a bare
`startSession()` nobody opened a transaction on, which type-checks perfectly,
commits the row on its own, and fails as lost moderation work with no trace on the
day something restarts between the two writes.

**The webhook receiver reads the bytes that arrived.** Mounted after a JSON parser
it refuses rather than verifying a signature over a re-serialisation. Test the
property, not the arrangement: assert `typeof req.body === 'undefined'` from
inside the route. Asserting the mount order only proves the order.

`packages/app/scripts/test-invariants.mjs` breaks each guard on purpose and
asserts the named test goes red — verifying first that the edit landed and that
the mutated tree still type-checks, because a mutation that did not apply produces
a false green indistinguishable from a real pass.

## Requirements

**MongoDB must be a replica set or a sharded cluster.** Multi-document
transactions do not exist on a standalone, and the first intake is where you would
find out. Assert the topology at boot.

## Testing your integration

`@oxyhq/crowdsource-testing` gives you the service: a sandbox that applies the
real ingestion rules and a simulator that signs deliveries exactly the way
production does. `src/__tests__/fullLoop.test.ts` in this package is the test to
copy — report → intake transaction → dispatcher → real client → sandbox → signed
webhook over a real socket → decision worker → your `apply`, with nothing between
those steps stubbed.

Run it against a real replica set (`mongodb-memory-server`), not a mocked driver.
A mocked driver can be made to agree with any claim about transactions and unique
indexes, which is exactly why it must not be the thing they are tested against.

## What you do not write

The outbox model, service and dispatcher; the delivery worker; the decision
worker; the inbound service; the webhook receiver; the cross-instance dedupe
store; the CrowdSource client; reconciliation; the enforcement claim, mode gate,
reversal lookup and audit row; the enforcement planning algorithm; the
`localStatus` mapping.

## License

MIT
