# CrowdSource

**Participatory moderation infrastructure.** Applications send reports about any
user-generated object; CrowdSource turns them into a case, draws an independent
jury at random, collects structured findings, publishes a versioned decision, and
returns it by webhook. The application decides what to enforce.

The infrastructure is centralized. The decisions are not: every case is judged by
a temporary jury of people selected by lottery, and no one can search for or
choose a case to review.

## Why it exists

Applications collect reports and then resolve them with internal panels,
individual judgement, or processes that do not scale — and the person who was
reported usually gets no explanation and no appeal. CrowdSource replaces that
with one auditable process: duplicate reports merge into a single case, evidence
is preserved as it was when reported, independent reviewers evaluate it blind, a
consensus engine decides, and an appeal creates a new jury rather than editing
the original decision.

## What it is not

- Not a public feed of accusations, and not open voting. Access to a case is
  granted by the server, temporary and blind.
- Not a way for an application to subtract points from someone. Only a finished
  moderation decision can produce a reputation effect, and only Oxy Trust's own
  engine decides what that effect is.
- Not a permanent archive of everything anyone reported, and not a universal
  blocklist without context, appeal or expiry.
- Not an AI judge. Automation may prioritize, translate and detect duplicates; it
  does not decide.

## Status

Early. The repository is a skeleton: the backend serves health checks, the
contracts and SDK packages are empty published boundaries, the reviewer app is
the foundation without review surfaces, and the console is not scaffolded. Each
package README states what it will hold.

## Structure

| Package | Name | Purpose |
| --- | --- | --- |
| `packages/contracts` | `@oxyhq/crowdsource-contracts` | Versioned contracts every surface agrees on |
| `packages/backend` | `@crowdsource/backend` | Express modular monolith over MongoDB |
| `packages/reviewer` | `@crowdsource/reviewer` | Reviewer app (Expo Router, web + native) |
| `packages/console` | `@crowdsource/console` | Developer + Trust & Safety console |
| `packages/sdk` | `@oxyhq/crowdsource` | TypeScript client for integrators |
| `packages/sdk-express` | `@oxyhq/crowdsource-express` | Webhook receiver middleware |
| `packages/testing` | `@oxyhq/crowdsource-testing` | Fixtures and a webhook simulator |

## Getting started

Requires [Bun](https://bun.sh) (the version pinned in `package.json`) and Node
22.17.0 for the Expo and Jest toolchains.

```bash
bun install
bun run dev:backend     # http://localhost:3000/health/ready
bun run dev:reviewer    # Expo dev server
```

`bun run check` runs the same gate CI does: workspace doctor, workflow
validation, security audit, build, type-check and lint.

Copy `packages/backend/.env.example` and `packages/reviewer/.env.example` to
`.env` for local configuration.

## License

MIT. See [LICENSE](LICENSE).
