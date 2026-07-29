import type { AppealAuthorContext, MetadataBag } from '@oxyhq/crowdsource-contracts';

/**
 * §9.8's "validación y redacción" of the author's additional context.
 *
 * This is the only text in the system written by the SUBJECT of a moderation
 * case, addressed to the jurors who will judge them, and it arrives from outside
 * with a motive attached. The contract has already bounded it — length, flat
 * scalar fields, no URLs or blobs, no prototype keys — and that is the structural
 * half. This file is the other half: what the bytes may still do once a person
 * reads them, and what a reviewer must not be shown.
 *
 * ## The four things being defended against, in order of how badly they end
 *
 *  1. **Deanonymising a reviewer.** A URL an author puts in a statement is a
 *     beacon: if a juror opens it, the person under review learns their IP, their
 *     rough location and the fact that their case is being reviewed right now.
 *     §9.1 keeps juror identity from everybody and §13.8 asks for pseudonymous,
 *     short-lived access to material; a live link from the author defeats both,
 *     and no amount of care in the client fixes it. Author evidence has a
 *     sanctioned route — §10.2's uploads, hashed and typed — so a URL here is
 *     replaced rather than shown.
 *  2. **Rewriting what the reader sees.** Bidirectional overrides and zero-width
 *     characters let a string display as something other than what it says.
 *     Stored in a field a reviewer and an operator both read, that is how a
 *     statement claims a sentence it does not contain.
 *  3. **Leaking somebody else's personal data.** An author defending a post
 *     routinely names third parties. §7.5 row 4 requires automatic redaction of
 *     personal data BEFORE review and §13.5 requires minimisation, so contact
 *     details and identifier-shaped numbers are masked.
 *  4. **Carrying a credential into the record.** Same rule as the webhook
 *     response preview: anything shaped like a secret is masked, because this
 *     value is persisted for as long as the case is.
 *
 * ## What is deliberately NOT done
 *
 * The hostile TEXT survives. An author whose post quoted a threat has to be able
 * to quote it back, and a filter that refused the sentence would refuse exactly
 * the defence the appeal exists to make. §13.5 is about identifiers and secrets,
 * not about tone — and the reviewer package labels this field as unverified
 * context from the author, the same way §9.1 makes an allegation an allegation.
 *
 * Redaction is applied ONCE, on the way in, and the redacted value is what is
 * stored. Redacting on the way out would leave the raw bytes in the database for
 * every later reader — an operator, an export, a backup — to find.
 */

/** What replaces a redacted run. Recognisable, and not itself matchable. */
const MARKER = '[redacted]';

/** What replaces a URL. Says what was removed, so the reviewer is not misled. */
const LINK_MARKER = '[link removed]';

interface RedactionRule {
  readonly what: string;
  readonly pattern: RegExp;
  /**
   * What the match becomes. A function rather than a string for every rule, not
   * only the one that needs it: a mixed shape would make the call site choose
   * between two `String.prototype.replace` overloads at runtime, and the rule
   * that has to inspect its own match (see the identifier-shaped number) is
   * exactly the rule most likely to be added next.
   */
  readonly replace: (match: string) => string;
}

/** How many digits a match actually contains, ignoring separators. */
function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/**
 * Ordered, and the order is load-bearing twice over: the most specific shapes run
 * first so a value is masked as what it is, and URLs run before the numeric rules
 * so a path segment full of digits does not turn into a marker inside a link that
 * was about to be removed anyway.
 */
const RULES: readonly RedactionRule[] = [
  {
    what: 'authorization header value',
    pattern: /\b(bearer|basic|token|apikey|api[_-]?key)\s+[\w.\-+/=]{8,}/gi,
    replace: () => MARKER,
  },
  {
    what: 'assignment of a secret-looking key',
    pattern:
      /\b(secret|password|passwd|token|api[_-]?key|authorization|signature|credential)\b"?\s*[:=]\s*"?[\w.\-+/=]{6,}"?/gi,
    replace: () => MARKER,
  },
  {
    what: 'json web token',
    pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
    replace: () => MARKER,
  },
  {
    what: 'email address',
    pattern: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g,
    replace: () => MARKER,
  },
  {
    what: 'url',
    /**
     * Bare hosts as well as full URLs, because `evil.example/track?j=1` is the
     * same beacon without the scheme. A dot followed by a plausible TLD is
     * required, so an ordinary sentence with a full stop survives.
     */
    pattern:
      /\b((https?|ftp|data|javascript):\/*[^\s<>"']+|[\w-]+(\.[\w-]+)*\.[a-z]{2,24}(\/[^\s<>"']*)?)/gi,
    replace: () => LINK_MARKER,
  },
  {
    what: 'telephone number',
    pattern: /(?:\+|\b00)\d[\d\s().-]{6,}\d/g,
    replace: () => MARKER,
  },
  {
    what: 'identifier-shaped number',
    /**
     * A national id, a card, an account, a case number in another system —
     * matched loosely, then held to NINE digits or more.
     *
     * The digit count is the whole rule, and a character count cannot stand in
     * for it: `2026-07-01` is ten characters and eight digits, so a
     * length-based rule redacts every date an author cites, which is context a
     * reviewer needs and a defence the author is entitled to make.
     */
    pattern: /\b\d[\d\s.-]{6,}\d\b/g,
    replace: (match) => (digitCount(match) >= 9 ? MARKER : match),
  },
  {
    what: 'high-entropy token',
    pattern: /\b[A-Za-z0-9+/=_-]{40,}\b/g,
    replace: () => MARKER,
  },
];

/**
 * Characters removed outright rather than replaced with a marker.
 *
 * Bidirectional overrides and isolates (U+202A–U+202E, U+2066–U+2069), zero-width
 * spaces and joiners (U+200B–U+200F), and the byte-order mark. None of them has a
 * meaning in a statement a human wrote; every one of them changes what the next
 * human reads.
 */
const INVISIBLE_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Control characters, minus the two that carry a paragraph.
 *
 * Newline and tab survive because an explanation has paragraphs and a redacted
 * wall of one line is harder for a reviewer to read than the original — and
 * "harder to read" is a cost paid by the person being judged.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]+/g;

/** Redacts one free-text field written by an author (§9.8, §7.5 row 4, §13.5). */
export function redactAuthorText(raw: string): string {
  let text = raw.replace(INVISIBLE_CHARACTERS, '').replace(CONTROL_CHARACTERS, ' ');

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match) => rule.replace(match));
  }

  /**
   * Runs of blank lines collapse to one blank line and trailing spaces go. Not
   * cosmetic: a statement padded with three hundred newlines is a statement that
   * pushes the rest of the case off a reviewer's screen.
   */
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]*\n/g, '\n')
    .trim();
}

/**
 * The author's context as a reviewer may see it.
 *
 * `resourceIds` pass through untouched — they are validated against the case's
 * own snapshot by the service, so by this point they name material the reviewer
 * is already looking at. Structured fields are redacted VALUE by value; their
 * keys are already restricted by the contract to a safe grammar, and a key is a
 * label an integrator chose rather than text an author wrote.
 */
export function redactAuthorContext(context: AppealAuthorContext): AppealAuthorContext {
  const statement = redactAuthorText(context.statement);

  return {
    /**
     * A statement that was ENTIRELY a link or a phone number redacts to nothing,
     * and the empty string is not stored: the appeal keeps a reason, and pretending
     * an explanation was supplied when none survived would show a reviewer an
     * empty box labelled "the author explained".
     */
    statement: statement.length === 0 ? MARKER : statement,
    ...(context.resourceIds === undefined ? {} : { resourceIds: [...context.resourceIds] }),
    ...(context.fields === undefined ? {} : { fields: redactFields(context.fields) }),
  };
}

function redactFields(fields: MetadataBag): MetadataBag {
  const redacted: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    redacted[key] = typeof value === 'string' ? redactAuthorText(value) : value;
  }
  return redacted;
}

/** The rules, for the test that proves each one can fire. */
export function authorTextRedactionRules(): readonly string[] {
  return RULES.map((rule) => rule.what);
}
