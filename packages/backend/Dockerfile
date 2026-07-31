# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-alpine AS manifests
WORKDIR /app

# Every workspace `packages/*` resolves to MUST be listed here, even ones this
# image never builds. `bun.lock` records the whole workspace set, so a manifest
# missing from the build context makes the set differ from the lockfile and
# `--frozen-lockfile` fails with `lockfile had changes, but lockfile is frozen`.
# Adding a package to `packages/` and not to this list breaks the deploy while
# every in-repo lockfile check still passes — both layers run where all the
# manifests exist. `packages/app` cost four hours of dead deploys that way.
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/app/package.json packages/app/
COPY packages/contracts/package.json packages/contracts/
COPY packages/backend/package.json packages/backend/
COPY packages/reviewer/package.json packages/reviewer/
COPY packages/console/package.json packages/console/
COPY packages/sdk/package.json packages/sdk/
COPY packages/sdk-express/package.json packages/sdk-express/
COPY packages/testing/package.json packages/testing/
RUN bun install --frozen-lockfile --ignore-scripts --lockfile-only

FROM manifests AS prod-deps
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --omit=dev --omit=peer --omit=optional --ignore-scripts \
    --filter @oxyhq/crowdsource-contracts --filter @crowdsource/backend

FROM manifests AS builder
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts --omit=peer --omit=optional \
    --filter @oxyhq/crowdsource-contracts --filter @crowdsource/backend

# The repo-root `scripts/` are build inputs, not just developer tooling:
# `packages/contracts`'s build script runs `../../scripts/write-esm-marker.mjs`
# to write the `{"type":"module"}` marker beside its ESM emit. Without the
# directory here the build fails inside Docker with
# `Module not found "../../scripts/write-esm-marker.mjs"` while every in-repo
# command still passes, because only the build CONTEXT is missing it.
COPY scripts/ scripts/
COPY packages/contracts/ packages/contracts/
COPY packages/backend/ packages/backend/

RUN bun run --cwd packages/contracts build
RUN bun run --cwd packages/backend build

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

ENV NODE_ENV=production

# The production dependencies are INSTALLED in `prod-deps` and COPIED here, so
# the runtime stage needs no lockfile, no install and no workspace manifests
# beyond the two it actually runs. It used to copy all eight manifests — because
# a frozen install needs the whole workspace set — and then delete the six it
# did not want. Copying files in order to delete them meant two enumerations
# that had to agree with each other and with `EXPECTED_WORKSPACE_PACKAGES` in
# `audit-runtime-image.mjs`, and each one broke a deploy when a package was
# added. There is nothing to keep in step now.
COPY --from=prod-deps /app/node_modules/ node_modules/
COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/packages/contracts/package.json packages/contracts/
COPY --from=prod-deps /app/packages/backend/package.json packages/backend/

COPY --from=builder /app/packages/contracts/dist/ packages/contracts/dist/
COPY --from=builder /app/packages/backend/dist/ packages/backend/dist/

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health/ready || exit 1

CMD ["bun", "packages/backend/dist/server.js"]
