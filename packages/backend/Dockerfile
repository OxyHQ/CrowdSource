# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Every image reference is pinned by digest: the digest is what the build uses,
# and the tag is kept only for readability. A tag can be re-pushed without a
# byte of this file changing, so it would move the build past the reviewed pin
# in .github/scripts/reviewed-images.json. A bump needs a new digest (the
# multi-arch index digest, which must list linux/arm64) and a re-review.

FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS manifests
WORKDIR /app

# Every workspace `packages/*` resolves to MUST be listed here, even ones this
# image never builds. `bun.lock` records the whole workspace set, so a manifest
# missing from the build context makes the set differ from the lockfile and
# `--frozen-lockfile` fails with `lockfile had changes, but lockfile is frozen`.
# Adding a package to `packages/` and not to this list breaks the deploy while
# every in-repo lockfile check still passes — both layers run where all the
# manifests exist. `packages/app` cost four hours of dead deploys that way,
# before it folded into `packages/core` as the `outbox` subpath.
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/backend/package.json packages/backend/
COPY packages/reviewer/package.json packages/reviewer/
COPY packages/console/package.json packages/console/
RUN bun install --frozen-lockfile --ignore-scripts --lockfile-only

FROM manifests AS prod-deps
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --omit=dev --omit=peer --omit=optional --ignore-scripts \
    --filter @crowdsource.you/contracts --filter @crowdsource/backend

FROM manifests AS builder
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts --omit=peer --omit=optional \
    --filter @crowdsource.you/contracts --filter @crowdsource/backend

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

FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

ENV NODE_ENV=production

# The production dependencies are INSTALLED in `prod-deps` and COPIED here, so
# the runtime stage needs no lockfile, no install and no workspace manifests
# beyond the two it actually runs. It used to copy every manifest — because
# a frozen install needs the whole workspace set — and then delete the ones it
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

# The SQL migrations. `tsc` copies no `.sql` file, so without this the image
# holds a migration entrypoint and nothing for it to apply — and that failure is
# quiet in the worst way: a migrations folder with no journal in it reads as "no
# migrations pending", so the one-shot task logs a success line and exits 0 while
# the database stays empty.
#
# The destination is under `dist/`, beside the COMPILED migrator, because
# `src/db/migrate.ts` resolves the folder relative to its own `__dirname` and
# `rootDir` mirrors the source tree into `dist/`. Copying to the source path
# instead puts the files somewhere nothing looks — measured, by running the
# built entrypoint. `deployWiring.test.ts` derives this destination from the
# constant itself rather than restating it.
COPY --from=builder /app/packages/backend/src/db/postgres/migrations/ \
  packages/backend/dist/src/db/postgres/migrations/

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health/ready || exit 1

CMD ["bun", "packages/backend/dist/server.js"]
