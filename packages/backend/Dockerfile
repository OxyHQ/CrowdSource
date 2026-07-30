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

FROM manifests AS builder
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts --omit=peer --omit=optional \
    --filter @oxyhq/crowdsource-contracts --filter @crowdsource/backend

COPY packages/contracts/ packages/contracts/
COPY packages/backend/ packages/backend/

RUN bun run --cwd packages/contracts build
RUN bun run --cwd packages/backend build

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

ENV NODE_ENV=production

COPY --from=manifests /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=manifests /app/packages/app/package.json packages/app/
COPY --from=manifests /app/packages/contracts/package.json packages/contracts/
COPY --from=manifests /app/packages/backend/package.json packages/backend/
COPY --from=manifests /app/packages/reviewer/package.json packages/reviewer/
COPY --from=manifests /app/packages/console/package.json packages/console/
COPY --from=manifests /app/packages/sdk/package.json packages/sdk/
COPY --from=manifests /app/packages/sdk-express/package.json packages/sdk-express/
COPY --from=manifests /app/packages/testing/package.json packages/testing/

RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --omit=dev --omit=peer --omit=optional --ignore-scripts \
    --filter @oxyhq/crowdsource-contracts --filter @crowdsource/backend
# Only the two runtime workspaces may exist in the final image; every other
# manifest above exists solely so the workspace lockfile resolves.
#
# Expressed as "keep these two" rather than "delete those five" on purpose. The
# delete-list is the complement of `EXPECTED_WORKSPACE_PACKAGES` in
# `audit-runtime-image.mjs`, so an enumeration has to be updated in two files
# whenever a package is added — and the failure is a broken deploy discovered
# after merge. `packages/app` was added to the COPY lines and not here, and the
# audit caught it exactly that way.
RUN for dir in packages/*/; do \
      case "$dir" in \
        packages/backend/|packages/contracts/) ;; \
        *) rm -rf "$dir" ;; \
      esac; \
    done

COPY --from=builder /app/packages/contracts/dist/ packages/contracts/dist/
COPY --from=builder /app/packages/backend/dist/ packages/backend/dist/

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health/ready || exit 1

CMD ["bun", "packages/backend/dist/server.js"]
