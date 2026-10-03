# Peer and source-map corrections — inactive

This supersedes candidate `0a3fdd55` for any future activation. The old policy,
census, logs and proof are retained as historical inputs. Neither candidate is
loaded by `audit:security`; `security-audit-exceptions.json` remains unchanged.

The exact added adversarial fixture reproduces five failures on the old helper:
adding a backend workspace peer or package peer left the fingerprint unchanged;
POSIX, Windows and malformed `sourceRoot` values were ignored. Explicit empty
`sourceRoot` passed as a positive control. The same fixture now passes all six
controls. It uses owned temporary maps, then removes them; this is not evidence
of a real product export.

The census now contains two explicit parts. Dependency reachability retains 58
ancestor records; separately, all 531 workspace/package peer declarations are
pinned with ranges, optional flags, resolved lock key and resolved-record hash.
Eighty declarations have no resolved lock entry and are explicitly marked null.
Peers are not silently counted as backend runtime edges: the byte-pinned Docker
install omits peers. Frontend materialization still requires actual export proof.
Every peer declaration or resolved-record change invalidates the fingerprint,
including a peer added outside the dependency ancestor graph.

Consequently the old assertion that an Oxy version change was unrelated is no
longer valid when that record resolves a peer. The intermediate regression log
retains its named failure; the corrected assertion now requires refusal. All 21
existing controls pass with that stricter expectation. The old candidate-installed
SDK graph differs from this policy, as expected: after final registry install the
exact final census needs another review before activation. Nothing auto-reseals it.

Source maps with any nonempty or non-string `sourceRoot` are now rejected.
Only absent or empty roots are supported, so `sources` cannot hide the forbidden
package under an uninspected base. Existing module-path and missing-map checks
remain. Final exports with external maps and the final backend image census are
still pending. No expiry extension: 2026-10-09 22:00:00 UTC remains the limit.
