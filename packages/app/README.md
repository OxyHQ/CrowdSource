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

`express` (4.18+ or 5) is a required peer as well.

## Storage is a subpath

The root entry is storage-free. Everything MongoDB-shaped — the schema fields
you compose into your own report model, the indexes its queries depend on, the
three collections this package owns, and the store the integration is wired with
— is behind `@oxyhq/crowdsource-app/mongoose`:

```ts
import { createModerationIntegration } from '@oxyhq/crowdsource-app';
import {
  mongooseModerationStore,
  moderationReportSchemaFields,
  applyModerationReportIndexes,
} from '@oxyhq/crowdsource-app/mongoose';
```

`mongoose` (8 or 9) is therefore an **optional** peer: a deployment that does not
import that subpath never installs it, and a bundler never has to resolve it.
Import the subpath without `mongoose` present and it fails at the import, by
name — rather than as a driver quietly missing at the first write.

`@oxyhq/db`, `drizzle-orm` and `postgres` are declared as optional peers for the
PostgreSQL half. **This version imports none of them**; they are listed so the
requirement is visible at install time rather than at first import, and
`postgres` in particular is `@oxyhq/db`'s own peer rather than anything this
package calls.

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
cannot install anything. **Two things it therefore cannot do**, so they belong
here, and they must be run per subpath:

```bash
# 1. Plain Node must be able to load the PACKED artifact, both entries and both
#    module systems.
bun pm pack
mkdir -p /tmp/esm-check && cd /tmp/esm-check && echo '{"name":"c","private":true}' > package.json
bun add <path-to>/oxyhq-crowdsource-app-*.tgz @oxyhq/crowdsource-contracts mongoose express
node --input-type=module -e "import('@oxyhq/crowdsource-app').then(m => console.log(Object.keys(m).length))"
node --input-type=module -e "import('@oxyhq/crowdsource-app/mongoose').then(m => console.log(Object.keys(m).length))"
node -e "console.log(Object.keys(require('@oxyhq/crowdsource-app/mongoose')).length)"

# 2. An esbuild ESM consumer must work with THIS PACKAGE INLINED. Externalise
#    the driver, never `@oxyhq/*` — see below.
npx esbuild entry.mjs --bundle --platform=node --format=esm --outfile=out.mjs \
  --external:mongoose --external:mongodb --external:express
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
