# Dependency audit boundaries

`bun run audit:security` runs the registry advisory check. Exceptions are matched
by package **and** advisory and expire; there are currently none. Own backend and
published parsers use patched Zod 4.6.7, and Expo's Node build CLI (58.1.18) no
longer resolves Zod 3. `node-forge` is pinned to the patched 1.4.2 by a root
override.

GHSA-27r3-jxmh-p828 is remediated with `body-parser@2.4.0`, the compatible
patched major selected by Express 5. No exception covers that HTTP parser.

The reviewer emits UTF-8 JavaScript strings directly. ASCII-only minification
expanded non-Latin locale characters into six-byte escapes without changing
runtime strings. Removing that expansion reduced the measured export from
10.59 MiB to 9.85 MiB (JavaScript 9.41 to 8.66 MiB); existing budget limits and
all locale modules remain in place.
