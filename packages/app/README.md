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

All of that is in here. You supply four things: your subjects, your category
mapping, your enforcement tables, and a STORE built by the factory of whichever
backend keeps your reports.

```bash
bun add @oxyhq/crowdsource-app @oxyhq/crowdsource-contracts
```

`@oxyhq/crowdsource-contracts` is a **peer** dependency, and bun installs a
missing peer silently with no warning at all — so install it explicitly. Two
copies of contracts produce no type error and no diagnostic; the symptom is every
webhook answering `400 malformed_event`, which reads as a delivery problem.

`express` (4.18+ or 5) is a required peer as well.

## Storage is a subpath

The root entry is storage-free. Everything driver-shaped lives behind a subpath —
`@oxyhq/crowdsource-app/mongoose` or `@oxyhq/crowdsource-app/postgres` — and an
adopting application picks its storage by which one it imports. The pipeline above
is identical either way.

### MongoDB
```ts
import { createModerationIntegration } from '@oxyhq/crowdsource-app';
import {
  mongooseModerationStore,
  moderationReportSchemaFields,
  applyModerationReportIndexes,
} from '@oxyhq/crowdsource-app/mongoose';

const store = mongooseModerationStore({
  connection,
  reportModel,
  enforcementActions: commerceEnforcement.actions,
});

const moderation = createModerationIntegration({
  store,
  crowdSource: { enabled: true, serviceKey, webhookSecret, enforcementMode: 'observe' },
  subjects: [listingSubjectProvider(), reviewSubjectProvider()],
  taxonomy: { version: '2026.07', allegationsFor },
  enforcement: commerceEnforcement,
  logger,
});

// Indexes before the first write: the unique ones ARE the exactly-once
// mechanism, and an index that does not exist yet refuses nothing.
await store.ensureSchema();

// BEFORE express.json() — the signature covers the bytes that arrived.
app.use('/webhooks', moderation.webhookRouter());
app.use(express.json());

moderation.dispatcher.start();
```

Write no type arguments: `createModerationIntegration` infers your report type
and your backend's transaction type from `store`, and your action union from
`enforcement`. TypeScript has no partial explicit type arguments, so naming one
would mean naming all three.

**Both examples above are compiled and constructed by
`src/__tests__/configTypeErgonomics.test.ts`**, which is the only way a documented
example stays true — nothing else ever executes one, so an example is the one part
of a package that can decay without anything failing. That file caught this
README calling `moderation.store.ensureSchema()` against an integration that
deliberately exposes no store, minutes after it was written.

Every driver is an **optional** peer — `mongoose` (8 or 9) for one subpath,
`drizzle-orm`, `postgres` and `@oxyhq/db` for the other. A deployment installs
only the ones its own subpath needs, and a bundler never has to resolve the rest.
Import a subpath without its driver present and it fails at the import, by name,
rather than as a driver quietly missing at the first write. (`postgres` is
`@oxyhq/db`'s peer rather than anything this package calls; it is listed so the
transitive requirement is visible at install time.)


### PostgreSQL

```ts
import { createModerationIntegration } from '@oxyhq/crowdsource-app';
import {
  moderationTables,
  moderationReportColumns,
  moderationReportTableExtras,
  postgresModerationStore,
} from '@oxyhq/crowdsource-app/postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';

// Declared ONCE and passed to both halves, so the columns and their CHECK
// constraints cannot drift apart.
const REPORT_MODERATION = {
  reportedTypes: ['listing', 'review'],
  categories: ['spam', 'harassment'],
};

// Your own table: our columns spread into it, plus whatever it already had.
export const reports = pgTable(
  'reports',
  {
    ...moderationReportColumns(REPORT_MODERATION),
    legacyStatus: text('legacy_status'),
  },
  moderationReportTableExtras(REPORT_MODERATION),
);

// The three tables this package owns. Re-export them from your schema so YOUR
// drizzle-kit run generates their DDL, in YOUR journal.
export const moderation = moderationTables({
  enforcementActions: commerceEnforcement.actions,
});

const store = postgresModerationStore({ db, reportTable: reports, tables: moderation });
```

## The four things you supply

| | MongoDB | PostgreSQL |
|---|---|---|
| your nouns | `subjects: [...]` — the same on both | |
| your categories | `taxonomy` — the same on both | |
| what you can do about a decision | `enforcement` — the same on both | |
| **your report storage** | `moderationReportSchemaFields()` spread into your Mongoose schema, `applyModerationReportIndexes()` on it, `mongooseModerationStore({ connection, reportModel, … })` | `moderationReportColumns()` spread into your drizzle `pgTable`, `moderationReportTableExtras()` as its third argument, `postgresModerationStore({ db, reportTable, tables })` |
| **the three tables we own** | created on first write; `store.ensureSchema()` builds their indexes | **`moderationTables()` returns drizzle tables you re-export from your schema, and YOUR `drizzle-kit generate` produces the DDL**; `store.ensureSchema()` only asserts they exist |

**That last row is the only genuinely new obligation, and it is unavoidable.**
Mongo creates a collection on first write; Postgres needs DDL, and DDL needs a
migration. **This package ships no migrations folder** and never will: a library's
journal and an adopter's journal interleave in one
`drizzle.__drizzle_migrations` table, and the loser is skipped **silently, with
exit 0**. You generate the SQL, you own the ledger.

### Stamping your own metadata on every report

`taxonomy.metadata` is optional and stamped on every report you send, under
this package's own `taxonomyVersion` and `categories` — an entry using either
of those names is ignored rather than shadowing them, because a case has to be
readable back against the mapping that produced it.

```ts
taxonomy: {
  version: '2026.07',
  allegationsFor,
  // A jury that can see material exists which it was not given can then answer
  // `insufficient_context` for the right reason instead of guessing.
  metadata: { evidenceAttachmentsSupported: false },
},
```

**Set it once and leave it.** Metadata rides in the `ReportInput`, the SDK
derives the case envelope from it, and ingress fingerprints that envelope to
detect "same external id, different body" — so changing it changes the envelope,
and a report still being retried across that change gets a permanent 409. That
is also why the field is opt-in: an adopter who sets nothing emits exactly what
it emitted before the field existed.

## Two registries you must merge — neither is optional

Both are fragments, not registries: they name this package's tables, so you spread
them into the ones you already keep.

```ts
import {
  moderationExpirySweepTargets,
  moderationIdColumnsWithoutForeignKey,
} from '@oxyhq/crowdsource-app/postgres';

export const EXPIRY_SWEEP_TARGETS = [
  ...myOwnTargets,
  ...moderationExpirySweepTargets(moderation),
];

export const ID_COLUMNS_WITHOUT_FOREIGN_KEY = [
  ...myOwnUnclassified,
  ...moderationIdColumnsWithoutForeignKey({ tables: moderation, reportTable: reports }),
];
```

**The expiry one fails silently; the id one fails loudly.** Postgres has no TTL
index, so a table registered nowhere simply grows forever — no error, no failing
test, no symptom until disk. The eight id columns, by contrast, fail your own
inherited `findIdColumnViolations` gate as `unclassified_id_column` on the day you
adopt; shipping the fragment is what stops you writing eight reasons by guessing.

### What sweeping the outbox costs you, stated because a registry entry with no such note reads as "unconditionally safe"

**The outbox is a TTL'd table that holds unprocessed WORK.** A stalled dispatcher
plus a sweep discards moderation work that was never delivered. The retention
window is ninety days, which is what makes that a documented consequence rather
than a hazard — but `dead_letter` rows, the ones a human still has to look at, sit
inside the same window and are swept on the same schedule. **Alert on
`dead_letter` and on outbox depth long before ninety days**; the sweep is the
backstop for a table nobody drained, not a queue policy.

The event log is the milder case: CrowdSource's retry schedule ends at 24 hours,
so a row deleted after ninety days cannot resurrect a duplicate delivery. What it
costs is the answer to "did CrowdSource tell us about this case, and when", which
is the first question asked when a report looks stuck.

### If you saw `Dynamic require of "zod" is not supported`

Fixed in **0.4.0**. Upgrade; no consumer configuration is needed.

Versions up to `0.3.0` shipped CommonJS only while declaring an `import`
condition that pointed at the CommonJS file. Plain Node coped — its ESM loader
handles a CJS package — but a bundler targeting ESM inlined it and rewrote each
internal `require()` of an external dependency into a shim that threw at first
call:

```
Error: Dynamic require of "zod" is not supported
    at node_modules/@oxyhq/crowdsource-contracts/dist/primitives.js
```

CI stayed green, the image built, the install succeeded, and the container died
at startup. It took a backend down on 2026-07-30.

From 0.4.0 every package in this family publishes both formats — real ESM behind
`import`, CommonJS behind `require` — so bundling and externalising both work,
and `--external:@oxyhq/*` is no longer required. It remains a sensible default
for a Node server bundle, but it is now a preference rather than a workaround.

## Before publishing this package (maintainers)

`bun run check` includes `check:module-format`, which asserts statically that
every declared export entry resolves `import` to real ESM and `require` to real
CommonJS, that the two are different files, that the `{"type":"module"}` marker
governing the ESM half exists, and that no package has silently LOST a subpath.
It reads manifests and build output only — it does not read this file, and it
cannot install anything. `check:migrations` packs each published package and
fails on any migration file in the tarball, which is the one arrangement here
that a helpful edit can undo without breaking anything locally. **Two things it therefore cannot do**, so they belong
here, and they must be run per subpath:

```bash
# 1. Plain Node must be able to load the PACKED artifact, both entries and both
#    module systems.
bun pm pack
mkdir -p /tmp/esm-check && cd /tmp/esm-check && echo '{"name":"c","private":true}' > package.json
bun add <path-to>/oxyhq-crowdsource-app-*.tgz @oxyhq/crowdsource-contracts mongoose express
node --input-type=module -e "import('@oxyhq/crowdsource-app').then(m => console.log(Object.keys(m).length))"
node --input-type=module -e "import('@oxyhq/crowdsource-app/mongoose').then(m => console.log(Object.keys(m).length))"
node --input-type=module -e "import('@oxyhq/crowdsource-app/postgres').then(m => console.log(Object.keys(m).length))"
node -e "console.log(Object.keys(require('@oxyhq/crowdsource-app/mongoose')).length)"
node -e "console.log(Object.keys(require('@oxyhq/crowdsource-app/postgres')).length)"

# 2. An esbuild ESM consumer must work with THIS PACKAGE INLINED. Externalise
#    the driver, never `@oxyhq/*` — see below.
npx esbuild entry.mjs --bundle --platform=node --format=esm --outfile=out.mjs \
  --external:mongoose --external:mongodb --external:postgres --external:express
node out.mjs
```

**Run both.** They fail differently and only the second catches the defect that
took a backend down on 2026-07-30: plain Node imports a CommonJS package quite
happily, so a checklist with only the first would have shipped it. The
distinction is the durable lesson — **exports being declared is not exports
being loadable**, and the two forms of "loadable" are not the same question.

**`--external:'@oxyhq/*'` is the wrong flag for check 2, and it took until the
subpath landed to notice.** It externalises exactly the code under test, so the
bundle proves nothing about the format this package publishes. Externalising the
DRIVER instead inlines every `@oxyhq/*` module into the ESM bundle, which is the
question worth asking — measured on 0.4.0: the bundle runs, and esbuild emits no
`Dynamic require` shim at all. Bundling with nothing external still fails, and
the failure is `Dynamic require of "fs"` from inside `mongodb`: a property of the
driver, not of this package. Read the module named in that error before
concluding anything — the 2026-07-30 defect named `@oxyhq/crowdsource-contracts`,
and only that class is ours to fix.

## Requirements

**On MongoDB: a replica set or a sharded cluster.** Multi-document transactions do
not exist on a standalone, and the first intake is where you would find out —
because a report and its delivery event commit together or not at all. Assert the
topology at boot rather than discovering it from a user's failed report.

**On PostgreSQL: nothing.** That precondition disappears entirely — the same
guarantee is one `BEGIN … COMMIT` on one pooled connection, which every Postgres
has — so there is no topology to assert and no boot-time check to write. Postgres
9.5+ for `ON CONFLICT`, which is every supported version.

One consequence worth stating because it is easy to read as a difference and is
not: neither backend serializes intake's duplicate-check-then-insert. Mongo's
snapshot isolation does not prevent that phantom and READ COMMITTED does not
either. **"One report per reporter per object" is your unique index to declare**,
on either backend; the check here answers the ordinary case with a readable error
rather than a constraint violation.

## Testing your integration

`@oxyhq/crowdsource-testing` gives you the service: a sandbox that applies the
real ingestion rules and a simulator that signs deliveries exactly the way
production does. `src/__tests__/fullLoop.test.ts` in this package is the test to
copy — report → intake transaction → dispatcher → real client → sandbox → signed
webhook over a real socket → decision worker → your `apply`, with nothing between
those steps stubbed.

Run it against a real database — a real replica set (`mongodb-memory-server`) or a
real Postgres — never a mocked driver or an in-memory Postgres emulator. A fake
can be made to agree with any claim about transactions, unique indexes,
`SKIP LOCKED` or an index's existence, which is exactly why it must not be the
thing they are tested against. This package's own suite runs every storage
assertion twice, once per backend, from one set of test bodies.

## What you do not write

The outbox table, service and dispatcher; the delivery worker; the decision
worker; the inbound service; the webhook receiver; the cross-instance dedupe
store; the CrowdSource client; reconciliation; the enforcement claim, mode gate,
reversal lookup and audit row; the enforcement planning algorithm; the
`localStatus` mapping.

And, on Postgres specifically: the `SKIP LOCKED` claim, the `ON CONFLICT DO
NOTHING` enqueue, the revision guard's `IS NULL` arm, the composite primary key
that IS the idempotency key, and the expiry sweep targets that replace Mongo's
TTL indexes. Every one of those is a line somebody would otherwise write once per
adopter, and each has a failure mode that is silent: a queue draining at 1/N the
rate, a repeated enqueue aborting its own transaction, a first decision matching
no rows, a redelivered decision acting twice, and a table that grows forever.

## License

MIT
