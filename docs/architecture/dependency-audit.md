# Dependency audit boundaries

`bun run audit:security` runs the lock-path mutation checks before the registry
advisory check. Exceptions are matched by package **and** advisory and expire;
a missing or malformed lock fails the path check.

Own backend and published parsers use patched Zod 4.6.7. The sole remaining
GHSA-mrhx-c7xc-m3w5 resolution is Expo's Node build CLI:
`expo@58.0.16 → @expo/cli@58.1.13 → zod@3.25.76`. There is no fixed Zod 3
release. `scripts/zod-audit-paths.mjs` fixes all three artifact versions and
integrities and inspects every incoming lock edge. A direct backend or SDK CLI
consumer, another transitive parent, an alias or another vulnerable Zod parser
is refused. It does not reinterpret Zod 3 as safe or force a breaking major into
Expo. Remove the exception when Expo adopts a patched parser; changed artifacts
require a fresh review. Its expiry is in `security-audit-exceptions.json`.

The CLI executes repository-owned export/build configuration. Static web exports
do not contain the Node CLI or its Zod 3 parser; the frontend's actual schema
validation remains patched Zod 4. Backend production installation filters the
backend dependency graph and omits optional/peer packages (see its Dockerfile).
The two published packages do not depend on the CLI. The mutation checks cover
new runtime consumers rather than assuming a package name makes them build-only.

GHSA-27r3-jxmh-p828 is remediated with `body-parser@2.4.0`, the compatible
patched major selected by Express 5. No exception covers that HTTP parser.

The reviewer emits UTF-8 JavaScript strings directly. ASCII-only minification
expanded non-Latin locale characters into six-byte escapes without changing
runtime strings. Removing that expansion reduced the measured export from
10.59 MiB to 9.85 MiB (JavaScript 9.41 to 8.66 MiB); existing budget limits and
all locale modules remain in place.
