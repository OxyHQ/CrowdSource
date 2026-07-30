/**
 * Finding code that reaches the MongoDB driver around the access layer.
 *
 * `collections.ts` makes the tenant filter the path of least resistance: the
 * Mongoose model is a `#private` field and the module that declares a collection
 * exports the wrapper instead. That leaves exactly one door open — the global
 * model registry and the raw driver handle — and a door nobody watches is a door
 * that gets used, usually by somebody in a hurry who does not know why it is
 * there.
 *
 * So this is the thing that watches it. It is a pure function over file contents
 * rather than a filesystem walk so that the test can feed it a deliberate
 * violation and confirm the check FAILS, which is the only way to know the check
 * is capable of failing at all.
 */

export interface ScannedFile {
  readonly path: string;
  readonly source: string;
}

export interface DriverEscape {
  readonly path: string;
  readonly line: number;
  /** The full offending line, not a capture group: a truncated match hides why. */
  readonly text: string;
  readonly rule: string;
}

interface EscapeRule {
  readonly rule: string;
  readonly pattern: RegExp;
}

const ESCAPE_RULES: readonly EscapeRule[] = [
  {
    rule: 'mongoose.model registry lookup',
    pattern: /\bmongoose\s*\.\s*model\s*\(/,
  },
  {
    rule: 'raw driver collection handle',
    pattern: /\.\s*collection\s*\(/,
  },
  {
    rule: 'direct database handle',
    pattern: /\bconnection\s*\.\s*db\b/,
  },
];

/**
 * The directories allowed to reach the driver, and why.
 *
 * This list is asserted by the test, so widening it is a visible edit to a test
 * rather than a quiet addition to a config file.
 */
export const DRIVER_ACCESS_ALLOWED = {
  'src/db/': 'The access layer itself — it is what wraps the driver.',
  'src/utils/database.ts': 'Opens and closes the connection.',
  'src/utils/mongoTopology.ts': 'Asks the deployment whether it can run transactions.',
  /**
   * ONE FILE, not the directory it sits in. Trust & Safety is by definition the audience
   * that reads across tenants (§4.3), and the tenant-scoped wrapper has no unscoped read
   * — correctly, and it must not gain one. So the cross-tenant reads live in a single
   * named module of specific projected queries; a directory entry would let any future
   * sibling reach the driver without a second thought.
   */
  'src/modules/trust/crossTenantReads.ts':
    'Trust & Safety reads across tenants by design; named queries only, projections baked in.',
} as const;

function isAllowed(path: string): boolean {
  return Object.keys(DRIVER_ACCESS_ALLOWED).some((allowed) => path.startsWith(allowed));
}

/** Every place a scanned file reaches the driver from outside the access layer. */
export function findDriverEscapes(files: readonly ScannedFile[]): DriverEscape[] {
  const escapes: DriverEscape[] = [];

  for (const file of files) {
    if (isAllowed(file.path)) continue;

    file.source.split('\n').forEach((text, index) => {
      // A comment explaining the rule is not a violation of it.
      const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      for (const { rule, pattern } of ESCAPE_RULES) {
        if (pattern.test(code)) {
          escapes.push({ path: file.path, line: index + 1, text: text.trim(), rule });
        }
      }
    });
  }

  return escapes;
}
