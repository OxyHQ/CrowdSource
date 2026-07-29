/**
 * Making a tenant's response body safe to store (§10.8, §13.4, §16.6).
 *
 * §10.9 requires every attempt to keep a truncated and redacted response body,
 * and that field is the one place in this module where bytes we did not compose
 * are written down. What comes back from a receiver is whatever its framework
 * decided to print: a stack trace, an HTML error page, an echo of the request it
 * could not parse, a log line carrying its own bearer token. §13.4 forbids
 * storing raw bodies without redaction, and §16.6 forbids evidence bodies in
 * logs at all — so this value is stored on the attempt row and never logged,
 * anywhere, at any level.
 *
 * The redaction here is deliberately blunt. A precise parser would have to
 * understand the receiver's format, and a value this module cannot interpret is
 * exactly the value most worth masking. Anything that LOOKS like a credential
 * becomes a marker; what survives is the short, human part of an error message
 * that tells an operator which way to look.
 */

/**
 * How much of a response is kept.
 *
 * Enough to hold the useful part of an error line, and short enough that the
 * field cannot become a place tenant data accumulates. The transport reads a
 * bounded prefix from the socket for the same reason — a receiver answering with
 * a gigabyte must not be able to spend our memory.
 */
export const WEBHOOK_RESPONSE_PREVIEW_LIMIT = 512;

/** What replaces anything that looks like a secret or an identity. */
const MARKER = '[redacted]';

interface RedactionRule {
  readonly what: string;
  readonly pattern: RegExp;
}

/**
 * Ordered, and the order matters: the most specific shapes run first so a
 * bearer token is masked as a bearer token rather than dissolving into the
 * generic high-entropy rule and losing the label an operator reads.
 */
const RULES: readonly RedactionRule[] = [
  {
    what: 'authorization header value',
    pattern: /\b(bearer|basic|token|apikey|api[_-]?key)\s+[\w.\-+/=]{8,}/gi,
  },
  {
    what: 'assignment of a secret-looking key',
    /**
     * The optional quote after the key name is what makes this fire on JSON.
     * `{"api_key":"…"}` puts a closing quote between the name and the colon, so
     * a pattern written for `api_key=…` matches shell output and misses every
     * JSON error body — which is the form a receiver actually answers with.
     */
    pattern:
      /\b(secret|password|passwd|token|api[_-]?key|authorization|signature|credential)\b"?\s*[:=]\s*"?[\w.\-+/=]{6,}"?/gi,
  },
  {
    what: 'json web token',
    pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  },
  {
    what: 'webhook signature',
    pattern: /\bv1=[0-9a-f]{32,}/gi,
  },
  {
    what: 'email address',
    pattern: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g,
  },
  /**
   * A long unbroken run of hex or base64. This is the catch-all for a value
   * whose shape says "key material" even when nothing around it does — an
   * unlabelled session id, a signature quoted on its own, a hash of something
   * that identifies a person.
   */
  {
    what: 'high-entropy token',
    pattern: /\b[A-Za-z0-9+/=_-]{40,}\b/g,
  },
];

/**
 * Truncates and redacts one response body.
 *
 * Truncation happens FIRST, on the raw bytes, so the cost of redaction is
 * bounded by the limit rather than by what a receiver chose to send: running six
 * regular expressions over a multi-megabyte string is a denial of service a
 * tenant could trigger by answering verbosely.
 *
 * The order does not weaken the result. A secret that begins inside the kept
 * prefix is still matched; one that begins past it was already discarded.
 */
export function redactResponseBody(raw: string): string {
  if (raw.length === 0) return '';

  const truncated = raw.length > WEBHOOK_RESPONSE_PREVIEW_LIMIT;
  let preview = raw.slice(0, WEBHOOK_RESPONSE_PREVIEW_LIMIT);

  /**
   * Control characters go first, and not for tidiness. A stored preview is read
   * back in a console and a terminal, and an ANSI escape or a carriage return in
   * an operator-facing field is how a hostile receiver rewrites what the
   * operator believes they are looking at.
   */
  preview = preview.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');

  for (const { pattern } of RULES) {
    preview = preview.replace(pattern, MARKER);
  }

  preview = preview.replace(/\s+/g, ' ').trim();
  return truncated ? `${preview}…` : preview;
}

/** The rules, for the test that proves each one can fire. */
export function redactionRuleNames(): readonly string[] {
  return RULES.map((rule) => rule.what);
}
