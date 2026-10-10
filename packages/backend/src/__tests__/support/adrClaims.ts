/**
 * Shared by the ADR gates (appealsAdr, communityNotesAdr): each ADR ends with a
 * fenced `adr-claims` block of `key: value` lines that its test compares against
 * the code. Lives here rather than in one of those test files, so neither test
 * imports the other.
 */

/** The `key: value` lines of the fenced `adr-claims` block. */
export function parseClaims(document: string): ReadonlyMap<string, readonly string[]> {
  const fenced = /```adr-claims\n([\s\S]*?)```/.exec(document);
  if (!fenced) throw new Error('the ADR has no fenced `adr-claims` block');

  const claims = new Map<string, readonly string[]>();
  for (const line of fenced[1].split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(':');
    if (separator < 0) throw new Error(`claim line is not 'key: value': ${trimmed}`);
    claims.set(
      trimmed.slice(0, separator).trim(),
      trimmed
        .slice(separator + 1)
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  }
  return claims;
}
