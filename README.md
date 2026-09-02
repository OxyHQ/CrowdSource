<p align="center">
  <b>CrowdSource is participatory moderation infrastructure.</b><br>
  Reports become cases, a jury drawn at random reviews them blind, and a versioned decision goes back by webhook.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oxyhq/crowdsource"><img alt="npm" src="https://img.shields.io/npm/v/@oxyhq/crowdsource?style=flat-square&color=440151&label=%40oxyhq%2Fcrowdsource"></a>
  <a href="./LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-informational?style=flat-square"></a>
  <img alt="Expo SDK 56" src="https://img.shields.io/badge/Expo-SDK%2056-000020?style=flat-square&logo=expo&logoColor=white">
  <img alt="React Native 0.85" src="https://img.shields.io/badge/React%20Native-0.85-61DAFB?style=flat-square&logo=react&logoColor=black">
  <img alt="TypeScript 5.9" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Bun 1.3.14" src="https://img.shields.io/badge/Bun-1.3.14-000000?style=flat-square&logo=bun&logoColor=white">
</p>

---

<table>
<tr>
<td valign="top" width="50%">

### Why it exists

Applications collect reports and then resolve them with internal panels, individual judgement, or processes that do not scale. The person who was reported usually gets no explanation and no appeal.

CrowdSource replaces that with one auditable process. Duplicate reports merge into a single case. Evidence is preserved as it was when reported. Independent reviewers evaluate it blind. A consensus engine decides. An appeal creates a new jury rather than editing the original decision.

The infrastructure is centralised. The decisions are not.

</td>
<td valign="top" width="50%">

### What it is not

Not a public feed of accusations, and not open voting. Access to a case is granted by the server, temporary and blind.

Not a way for an application to subtract points from someone. Only a finished moderation decision can produce a reputation effect, and only Oxy Trust decides what that effect is.

Not a permanent archive of everything anyone reported, and not a universal blocklist without context, appeal or expiry.

Not an AI judge. Automation may prioritise, translate and detect duplicates. It does not decide.

</td>
</tr>
</table>

## Invariants

These come from the approved product specification. They are not preferences. A change that violates one is wrong even if it passes review.

- **Nobody chooses the case they review.** The server issues an assignment. There is no case search, no shareable case link, no public queue.
- **A reviewer never sees partial votes**, other jurors' identities, the reporter's identity, or anyone's reputation.
- **One qualified person, one vote.** Reputation affects eligibility and selection probability, never the weight of a vote inside a jury.
- **A published decision is never edited, only superseded.** An appeal creates a new revision.
- **One penalty per incident.** A hundred reports about the same material produce one case and one consequence.
- **Every effect is idempotent, explainable and reversible**, and carries the policy version it was decided under.
- **Sensitive content never reaches logs, metrics or attestations.**
- **Absence of consensus is neither guilt nor innocence.** `inconclusive` is its own outcome and never collapses into `no_violation`.
- **`applicationId` comes from the credential, never from the request body.**
- **No binding proof, no reputation effect.** An application emits a report; CrowdSource emits a decision.

## Workspaces

| Package | Path | What it holds |
|---|---|---|
| [`@oxyhq/crowdsource-contracts`](https://www.npmjs.com/package/@oxyhq/crowdsource-contracts) | [`packages/contracts`](./packages/contracts) | The versioned contracts every surface agrees on, as Zod schemas and JSON Schema: case envelope, resources, taxonomy, policies, reviews, decisions, webhooks, reputation events |
| `@crowdsource/backend` | [`packages/backend`](./packages/backend) | Express 5 modular monolith over MongoDB: tenancy, ingestion, evidence, cases, sortition, review, consensus, decisions and webhook delivery |
| `@crowdsource/reviewer` | [`packages/reviewer`](./packages/reviewer) | The reviewer app, Expo Router and React Native Web from one codebase |
| `@crowdsource/console` | [`packages/console`](./packages/console) | Developer and Trust and Safety console, Expo Router on the web only |
| [`@oxyhq/crowdsource`](https://www.npmjs.com/package/@oxyhq/crowdsource) | [`packages/sdk`](./packages/sdk) | TypeScript client for integrators: reports, uploads, cases, decisions |
| [`@oxyhq/crowdsource-express`](https://www.npmjs.com/package/@oxyhq/crowdsource-express) | [`packages/sdk-express`](./packages/sdk-express) | Express webhook receiver: raw body capture, HMAC verification, replay protection, typed events |
| `@oxyhq/crowdsource-app` | [`packages/app`](./packages/app) | PostgreSQL-only application integration: transactional outbox, delivery, receiver, decision application and idempotent enforcement. The 0.7 source is a breaking migration from the former Mongoose subpath; publication is separate. |
| [`@oxyhq/crowdsource-testing`](https://www.npmjs.com/package/@oxyhq/crowdsource-testing) | [`packages/testing`](./packages/testing) | Fixtures, a webhook simulator and an in process sandbox, so you can integrate before a jury has ever sat |

Each package README says what that package holds.

## Integrating

An adopting application writes four things and nothing else: its subject providers, its category to allegation mapping, its enforcement tables plus one `apply`, and its own PostgreSQL report table. Everything it would otherwise copy, the outbox, delivery, the webhook receiver, cross instance dedupe, decision application, the enforcement claim and the enforcement planning algorithm, lives in `@oxyhq/crowdsource-app`.

```bash
bun add @oxyhq/crowdsource @oxyhq/crowdsource-express
```

Two rules follow from that design and bind every change to those packages.

- **The service key carries the tenant.** An integrator configures `applicationId:credentialId:secret`, so the client already knows which application it is. There is no `applicationId` option, field or parameter to pass, and the copy inside the envelope exists only so a mismatch can be detected.
- **Nothing the client composes may vary between two deliveries of the same report.** Ingress fingerprints the whole payload to detect conflicts, so an invented timestamp, a random id or an unsorted list turns a legitimate outbox retry into a permanent conflict, silently, days later.

Start with the [integration guide](./docs/integration.md).

## Quick start

Requires [Bun](https://bun.sh) 1.3.14 and Node.js 22.17.0 for the Expo and Jest toolchains.

```bash
bun install
bun run dev:backend     # http://localhost:3000/health/ready
bun run dev:reviewer    # reviewer app, Expo
bun run dev:console     # console, Expo web
```

Copy `packages/backend/.env.example` and `packages/reviewer/.env.example` to `.env` for local configuration.

<details>
<summary><b>Checks, builds and tests</b></summary>

<br>

```bash
bun run check           # the same gate CI runs
bun run build           # contracts, backend, SDKs
bun run build:reviewer  # reviewer static web export
bun run build:console   # console static web export
bun run test            # vitest for the backend and the libraries, jest for the two Expo apps
bun run lint
```

`check` is the whole gate: workspace doctor, workflow validation, security audit, injection sink scan, peer contract check, build, published shape checks, type check and lint.

Rebuild `contracts` before you believe a red type check. Every other package imports the built shape, never `src`, so after a rebase that lands a contracts change the rest of the repo still compiles against the previous build and reports the new symbols as missing in files nobody touched.

</details>

## How it fits the Oxy platform

CrowdSource is a product of its own, not a feature of any application that uses it. It began as a fork of [Mention](https://github.com/OxyHQ/Mention), taken for the Expo and Bloom monorepo foundation only, and shares no data, identity, service or deployment with it.

Reviewers, developers and Trust and Safety staff sign in with their [Oxy](https://github.com/OxyHQ/oxy) account. The apps mount one `OxyProvider` from `@oxyhq/services` and the backend verifies sessions with `@oxyhq/core/server`, in one place, never an app local bearer parser. Applications calling the ingestion API use CrowdSource's own service credentials instead, and the two authentication surfaces never satisfy each other's routes.

Reputation only ever moves in one direction. CrowdSource emits an authenticated event and Oxy Trust's own consequence engine decides the effect.

## Documentation

| Area | Contents |
|---|---|
| [Integration](./docs/integration.md) | Connecting an application end to end |
| [Architecture](./docs/architecture) | The universal case envelope, appeals, reputation axes, the threat model, and where the implementation diverges from the plan |
| [API](./docs/api) | The application, reviewer, console and webhook surfaces |
| [Policies](./docs/policies) | The policy sets cases are decided under |
| [Runbooks](./docs/runbooks) | Webhook dead letters, outbox backlog, a case that cannot empanel, audit trails |

Instructions for AI coding agents live in [`AGENTS.md`](./AGENTS.md).

## Contributing

Issues and pull requests are welcome, and criticism of the design is the most useful kind. Please run `bun run check` and `bun run test` first. Org wide [contributing notes](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md), the [security policy](https://github.com/OxyHQ/.github/blob/main/SECURITY.md) and the [code of conduct](https://github.com/OxyHQ/.github/blob/main/CODE_OF_CONDUCT.md) live in the organisation profile.

## License

MIT. See [LICENSE](./LICENSE).
