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

`mongoose` (8 or 9) and `express` (4.18+ or 5) are peers too.

### If you bundle your backend, externalise `@oxyhq/*`

**Read this before your first deploy.** If your build bundles to ESM — esbuild
with `format: 'esm'`, or anything similar — you must keep the Oxy packages
external:

```ts
// esbuild
external: ['@oxyhq/*']          // or --external:@oxyhq/*
```

Without it the container **dies at startup**, with green CI, a clean image
build, and a successful `npm install`:

```
Error: Dynamic require of "zod" is not supported
    at node_modules/@oxyhq/crowdsource-contracts/dist/primitives.js
```

Every package in this family is published as CommonJS, deliberately. Node's own
ESM loader imports them correctly, so `import` from a plain Node process works
and always has. A bundler targeting ESM does something different: it **inlines**
the CommonJS and rewrites each internal `require()` of an external dependency
into a shim that throws the first time it runs. Externalising leaves resolution
to Node, which handles it.

Two things measured, so you don't repeat them:

- **Bundling `zod` instead of externalising it does not help.** The shim is
  created for the inlined CJS module regardless.
- **Removing the `import` condition from our `exports` would not help either.**
  Resolution falls through to `default` and lands on the same CommonJS file.

The alternative — shipping a real ESM build alongside — was considered and
rejected: it would let a consumer resolve two copies of the contracts package,
which produces no type error and no diagnostic, and whose only symptom is every
webhook answering `400 malformed_event`.
 The same silence
applies in the other direction: bun will install a mongoose that does **not**
satisfy the range without saying so, so a peer mismatch here is something you
check rather than something you get told.

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

#### Reporting an account has a tenancy consequence — read this before registering one

`applicationId` is read off your service credential, so a report you submit opens
a case in **your** tenant. For an object you own that is exactly right. For an Oxy
identity it is not: the case names a principal only Oxy can act on, and when a
second Oxy application reports the same person under its own credential the dedup
key (`applicationId + subject external id + content hash + policy version`)
differs by tenant — so one person yields two cases, two juries and two
consequences, breaking "one penalty per incident" at a layer neither application
can repair.

That is an argument for care, not a prohibition. `identity.profile` is a real
subject type and an application whose own profile surfaces are what a jury would
judge may well register one. What it is not is a route to having somebody's Oxy
account sanctioned: an application can never move a reputation figure directly,
and cross-application hand-off is a question the contract does not answer yet.
Registering **no** provider for a reported account is a supported answer — the
report is still stored, still counted, and simply never leaves.

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
  restoreAction: ['relist', 'unflag'],  // the actions that UNDO — never ['delist','flag']
  recommendationToAction: { remove: 'delist', hide: 'delist', label: 'flag', restore: 'relist', /* … */ },
  severityFallback: { critical: 'review', high: 'delist', medium: 'flag', low: 'review' },
  absorb: { delist: ['flag', 'none', 'relist'] },
  precedence: ['delist', 'relist', 'flag', 'unflag', 'review', 'none'],
  reversibleActions: ['relist', 'unflag'],
  reverses: { relist: ['delist', 'freeze'], unflag: 'flag' },  // a list when one action reverses several

  async apply({ action, subject, previousState }) {
    // …change your own state, or say why there was nothing to change
    return { changed: true, previousState: { status: listing.status } };
  },
};
```

**`restoreAction` holds the actions that DO the undoing, not the ones being
undone.** `['relist', 'unflag']`, never `['delist', 'flag']` — the planner emits
these on `no_violation`, and `reverses` is the separate map saying what each one
undoes. Getting it backwards does not fail; it type-checks, plans, and applies a
**punishment on an accepted appeal**. Two people inverted it in one hour,
including the person who wrote the field.

**Declare every reversible action in `restoreAction`, not just one.** If your
levers are "hide it" and "label it", a correction has two things to undo, and
naming one leaves the other stuck forever — the object comes back visible and
stays labelled, with no error and nothing failing. A restore that finds nothing
to undo costs an audit row, not a wrong effect.

**Declare `restoreAction` if you have one.** A correction is a new revision whose
outcome is `no_violation` and whose recommendation is frequently `no_action` —
which means "take no NEW action", not "leave what you already did in place". Map
that straight through and the listing an earlier revision removed stays removed
forever: the appeal succeeded, the case says the content was fine, and nothing
ever puts it back. No error, no log line, no failing test. Declaring
`restoreAction` makes `no_violation` always plan the restore; the executor records
"there was nothing to undo" when that is the case, which is evidence rather than a
silent no-op.

If a planned action cannot apply to *this* object — your restore lever exists
for sellers but not for buyers, say — return `recordedAs` alongside the reason:

```ts
return { changed: false, reason: 'a buyer has no suspendable state', recordedAs: 'none' };
```

The plan is computed before `apply` runs and is deliberately subject-blind, so it
must name `restore`; `apply` is the only place that knows this object has no such
lever. The enforcement row keeps the **planned** action (it is half the
idempotency key, and it is what was decided) and carries the effective label
alongside; the report's `enforcedAction` uses the effective one. Without it a
report reads "decided: restore" about an object nothing ever restricted — which
for an application whose levers are subject-specific can be the majority of its
`no_violation` outcomes.

`{ changed: false, reason }` is **not** a failure — the object is already gone, or
there was no restriction to undo. It is recorded with its reason, which is how "we
checked and there was nothing to do" stays distinguishable from "we never looked".
Throw only for a real failure; the idempotency claim is then released so a retry
can try again.

`previousState` is yours and opaque to this package: it is written on the
enforcement row when an action is applied, and handed back to `apply` when a later
revision reverses it (per `reverses` — which takes an action or a LIST, when one
action reverses several; the lookup returns the most recent applied row across
the whole set). Keep it small, flat and JSON-serialisable,
and never put reported material in it. The lookup reads the most recent
**applied** row, so an action that was claimed but never carried out — observe
mode, a mode that declined it, an effect that found nothing to do — can never be
mistaken for one that changed something.

#### Adding the state your `apply` sets: the drift that survives testing

Almost every adopter adds a new value to an existing status enum — `restricted`,
`frozen`, `hidden`, whatever `apply` writes. Two things make getting it wrong
invisible, and they compound:

**A hand-written list satisfies the type.** If your Mongoose schema restates the
values (`const STATUSES: readonly ListingStatus[] = [...]`), a *subset* still
type-checks, so the schema enum silently never learns the new value. No compile
error. Export one list and have both the union and the schema read it.

**`updateOne` does not run validators; `save()` does.** So your enforcement path
writes the new status happily and every moderation test passes — while an
unrelated user path that ends in `save()` starts failing validation on a field
the user never touched. In `mercaria` this surfaced as a seller editing the
*title* of a restricted listing and getting
`ValidationError: status: 'restricted' is not a valid enum value`.

Worth a table test that creates your object at each value in the exported list.
Credit: `mercaria`, who lost an afternoon to it so you do not have to.

Three modes. `observe` runs the plan, the claim and the audit row and skips only
the effect, so it is a real rehearsal rather than a log line. `manual` additionally
applies `reversibleActions` — the actions that give something back, because
holding those behind a human means a wrongly-removed listing stays removed while
somebody reads a queue. `automatic` applies everything.

`enforcedAction` on the report says what you **decided**; `enforcedAt` says an
effect **landed**. They are written separately and `enforcedAt` stays unset for an
action that was only recorded — in `observe` mode that is every action, so
conflating them would stamp a timestamp on something that never happened for every
decided report.

#### If your application has nothing to enforce with

Some applications have no platform-level sanction primitive at all. An
end-to-end-encrypted messenger is the clearest case: the server cannot read the
material, so it cannot label it, and its block/restrict relations are written by
one user about their own inbox rather than by the platform about an account.
Writing those on a user's behalf because a field said `violation` would be a
product decision made by a queue.

That is a supported shape, not an unfinished one, and it needs three fields:

```ts
const enforcement: ModerationEnforcementConfig<'none' | 'review'> = {
  actions: ['review', 'none'],
  noneAction: 'none',
  reviewAction: 'review',
  restoreAction: null,
};
```

No `apply`, no tables. Every planned action is recorded as `recorded` with a
reason, so "CrowdSource decided this and we have no way to carry it out" is
written down instead of lost — which is the record that would justify building
the primitive later. The idempotency claim still applies, so a redelivered
decision is still recorded exactly once.

`restoreAction` is **required** and `null` is the answer here. An absent key
cannot be told apart from a forgotten one, and forgetting is the silent bug two
paragraphs up; `null` is a decision the compiler makes you write down.

Omitting `apply` is not the same as `observe` mode. The mode is a deployment
choice you can switch off; this is a property of the application.

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

### Writing a check that can actually fail

Four rules, each of which cost somebody an afternoon while this package was
built. They are about verification, not about this package, and they transfer.

- **The obvious fix passes the obvious test.** A retry test asserting
  `countDocuments === 1` stays green through a defect where the retry WRITES —
  "same row" and "no write happened" are different claims, and only the second
  is the property. Name the property, then ask what would still pass without it.
- **The goal is not "write a test that can fail" — it is to KNOW which of the
  two you wrote, and only a mutation tells you.** A test that happens to be
  sound and a test that cannot fail look identical in a green run, and authors
  are equally confident about both. (`mention-finish`, after a replay test that
  passed under the wrong fix because it short-circuited before reaching the code
  it claimed to exercise.)
- **A guard that reads as the proof is how the proof stops being looked for.**
  Say in the file which assertion is load-bearing and which is corroboration.
- **An unbounded observation of a race has no verdict.** Three of us measured one
  defect on one topology and got an abort, an 88-second hang, and a clean pass.
  Bound it (`maxTimeMS`) so it fails fast and NAMED, or a red run tells the next
  person nothing about whether the guard or the harness broke.
- **Pick the security control your route depends on, imagine deleting it, and
  ask which test goes red.** On the webhook route the HMAC is the entire
  authentication; six tests can cover that route and all six still pass with
  verification removed.

Credit, in order: `mercaria`, `noted-moovo` and `mercaria` again, `allo` and
`noted-moovo`, `alia-syra`.

`packages/app/scripts/test-invariants.mjs` breaks each guard on purpose and
asserts the named test goes red — verifying first that the edit landed and that
the mutated tree still type-checks, because a mutation that did not apply produces
a false green indistinguishable from a real pass.

## Before publishing this package (maintainers)

`bun run check` includes `check:module-format`, which asserts the CommonJS-only
shape statically and that this guide still carries the mitigation above. That
runs on every pull request. **Two things it cannot do**, because they need a
network install, so they belong here:

```bash
# 1. Plain Node ESM must be able to import the PACKED artifact.
bun pm pack
mkdir -p /tmp/esm-check && cd /tmp/esm-check
bun add <path-to>/oxyhq-crowdsource-app-*.tgz @oxyhq/crowdsource-contracts mongoose express
node --input-type=module -e "import('@oxyhq/crowdsource-app').then(m => console.log(Object.keys(m).length))"

# 2. An esbuild ESM consumer must work WITH the documented mitigation,
#    and is expected to fail without it.
npx esbuild entry.mjs --bundle --platform=node --format=esm --outfile=out.mjs --external:'@oxyhq/*'
node out.mjs
```

**Run both.** They fail differently and only the second catches the defect that
took a backend down on 2026-07-30: plain Node imports a CommonJS package quite
happily, so a checklist with only the first would have shipped it. The
distinction is the durable lesson — **exports being declared is not exports
being loadable**, and the two forms of "loadable" are not the same question.

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
