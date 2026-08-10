import type { ScannedFile } from '../driverEscapes';

/**
 * Who reads a table that has no tenant policy.
 *
 * The registry's four kinds each say why no policy predicate is correct. None of
 * them says anything about READERS — `tenant_attributed_not_tenant_owned` used to,
 * and was renamed precisely because `staff_audit_events` has no production reader
 * and the claim could not be honoured. That rename is an improvement in honesty
 * and it has a cost, which this file exists to pay:
 *
 *   A table with no policy returns EVERY tenant's rows to EVERY reader.
 *
 * After the rename nothing in the vocabulary carries that. So the complete reader
 * set becomes a fact somebody has to hold, and holding it in prose means it is
 * true on the day it is written and unchecked forever after. A fourth reader
 * appearing later is exactly how a deliberate cross-tenant exemption becomes an
 * accidental leak, and it would otherwise be invisible until somebody re-derived
 * the whole thing by hand.
 *
 * WHAT THIS CENSUS CAN AND CANNOT DO — read this before trusting it.
 *
 *  - It bounds TODAY's readers. It cannot bind tomorrow's; what it does is make
 *    tomorrow's arrival fail the build instead of passing unnoticed.
 *  - It finds call sites through the collection WRAPPER. A module that reached the
 *    Mongoose driver directly would be invisible here — that is
 *    `collectionBoundary.test.ts`'s job, and the two are complementary rather than
 *    redundant.
 *  - It attributes a call site to the nearest preceding TOP-LEVEL declaration. That
 *    is a heuristic, not a parse: a call inside a nested closure is attributed to
 *    the top-level function containing it, which is what one wants, but a file
 *    organised unusually could attribute oddly. The FILE half is exact; the SYMBOL
 *    half is the heuristic's.
 *  - It says nothing about whether a reader SHOULD exist. It is a census, not a
 *    judgement.
 */

/**
 * The wrapper methods that can move rows.
 *
 * `ensureIndexes` is deliberately EXCLUDED and this is the one exclusion: it
 * creates indexes and returns no documents, so it cannot disclose a row. Every
 * other public method on `UnscopedCollection` is here. Excluding it silently would
 * be the same defect this file exists to prevent, one level down — hence the
 * exclusion is written out rather than achieved by omission.
 */
export const COLLECTION_DATA_METHODS = [
  'countDocuments',
  'find',
  'findOne',
  'findOneAndUpdate',
  'insertOne',
  'updateOne',
] as const;

/**
 * How a table's rows are reached in source.
 *
 * Two kinds, because one table is not a Mongo collection at all:
 * `reviewer_principal_links` was extracted from `ReviewerProfile.principalLinks`,
 * so its readers touch a FIELD rather than a collection wrapper. Mapping it to a
 * collection accessor would find nothing and read as "no readers", which is the
 * failure mode this whole file is about.
 */
export interface TableAccessor {
  readonly kind: 'collection_export' | 'embedded_field';
  /** The exported wrapper's name, or the embedded field's name. */
  readonly identifier: string;
}

/**
 * Table → how to find its readers.
 *
 * HAND-MAINTAINED ON PURPOSE, and its completeness is asserted rather than
 * assumed: the gate fails for any unscoped table absent from this map, so a table
 * cannot become uncensused by nobody adding it.
 *
 * It must NOT be derived from the table name. `app_trust_snapshots` is reached
 * through `applicationTrust`, and `organization_members` through
 * `organizationMembers` — a derivation over arbitrary names would be right often
 * enough to look correct and wrong exactly where a collection was renamed, which
 * produces a check that cannot fail.
 */
export const UNSCOPED_TABLE_ACCESSORS: Readonly<Record<string, TableAccessor>> = {
  app_trust_snapshots: { kind: 'collection_export', identifier: 'applicationTrust' },
  application_credentials: { kind: 'collection_export', identifier: 'applicationCredentials' },
  applications: { kind: 'collection_export', identifier: 'applications' },
  assignments: { kind: 'collection_export', identifier: 'assignments' },
  organization_members: { kind: 'collection_export', identifier: 'organizationMembers' },
  organizations: { kind: 'collection_export', identifier: 'organizations' },
  outbox_events: { kind: 'collection_export', identifier: 'outboxEvents' },
  reviewer_affinities: { kind: 'collection_export', identifier: 'reviewerAffinities' },
  reviewer_principal_links: { kind: 'embedded_field', identifier: 'principalLinks' },
  reviewer_profiles: { kind: 'collection_export', identifier: 'reviewerProfiles' },
  reviewer_relations: { kind: 'collection_export', identifier: 'reviewerRelations' },
  reviews: { kind: 'collection_export', identifier: 'reviews' },
  sortition_draws: { kind: 'collection_export', identifier: 'sortitionDraws' },
  staff_audit_events: { kind: 'collection_export', identifier: 'staffAuditEvents' },
  trust_safety_staff: { kind: 'collection_export', identifier: 'trustSafetyStaff' },
  webhook_deliveries: { kind: 'collection_export', identifier: 'webhookDeliveries' },
};

/** One place a table's rows are reached. */
export interface ReaderSite {
  readonly table: string;
  /** Repository-relative, e.g. `src/modules/review/reviewHistory.ts`. */
  readonly file: string;
  /** The enclosing top-level declaration, or `<module>` for a top-level statement. */
  readonly symbol: string;
  readonly line: number;
  readonly text: string;
}

/** `src/modules/review/reviewHistory.ts#listReviewHistory` — how a reader is declared. */
export function formatReaderSite(site: Pick<ReaderSite, 'file' | 'symbol'>): string {
  return `${site.file}#${site.symbol}`;
}

/** A top-level `function x` / `const x` / `class x`, exported or not. */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/;

/**
 * The nearest top-level declaration at or above `index`.
 *
 * Top-level only — the regex is anchored with no leading whitespace — so a call
 * inside a nested arrow function resolves to the exported function containing it
 * rather than to some inner `const`. That is the attribution a reader census
 * wants: the named thing another module can call.
 */
function enclosingSymbol(lines: readonly string[], index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const match = TOP_LEVEL_DECLARATION.exec(lines[i]);
    if (match) return match[1];
  }
  return '<module>';
}

/**
 * Blanks comment bodies so prose about a read is not counted as a read.
 *
 * Three passes, and the third is not redundant: a line whose first non-space
 * character is `*` is a doc-comment continuation, which the block pass already
 * removes when the block is intact — but NOT when a fragment is scanned on its own,
 * and not if a block's terminator is ever mangled. `driverEscapes.ts` treats such a
 * line as a comment for the same reason, and agreeing with it matters more than the
 * marginal case: two scanners over one tree disagreeing about what a comment is
 * would make one of them report a breach the other cannot see.
 *
 * Line COUNT is preserved throughout — bodies are blanked, never deleted — because
 * a site's reported line number has to survive the stripping.
 */
function withoutComments(source: string): string {
  // `replace` with a global pattern rather than `replaceAll`: this package
  // compiles against `lib: ES2020`, where `String.prototype.replaceAll` does not
  // exist. The two are equivalent for a `/g` regex. Test files compile under a
  // different tsconfig and may use `replaceAll`, which is why the same call is
  // fine one directory over and not here.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block: string) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .split('\n')
    .map((line: string) => (/^\s*\*/.test(line) ? '' : line))
    .join('\n');
}

function accessorPattern(accessor: TableAccessor): RegExp {
  if (accessor.kind === 'embedded_field') {
    // A field read: `profile.principalLinks`, `principalLinks:` in a projection,
    // or a destructure. Deliberately broad — for an embedded field an over-broad
    // match produces an entry somebody must explain, while a narrow one produces
    // a silent absence.
    return new RegExp(`\\b${accessor.identifier}\\b`);
  }
  return new RegExp(`\\b${accessor.identifier}\\.(?:${COLLECTION_DATA_METHODS.join('|')})\\b`);
}

/**
 * Every place any unscoped table's rows are reached, attributed to file and symbol.
 *
 * Comment bodies are stripped first, so a module documenting what it must not do
 * is not counted as doing it — the `driverEscapes` rule, which this file inherits
 * because both scan the same tree for the same class of claim.
 */
export function findUnscopedReaders(
  sources: readonly ScannedFile[],
  accessors: Readonly<Record<string, TableAccessor>> = UNSCOPED_TABLE_ACCESSORS,
): ReaderSite[] {
  const sites: ReaderSite[] = [];

  for (const file of sources) {
    const lines = withoutComments(file.source).split('\n');

    for (const [table, accessor] of Object.entries(accessors)) {
      const pattern = accessorPattern(accessor);

      lines.forEach((text, index) => {
        if (!pattern.test(text)) return;
        sites.push({
          table,
          file: file.path,
          symbol: enclosingSymbol(lines, index),
          line: index + 1,
          text: text.trim(),
        });
      });
    }
  }

  return sites;
}

/** A site the pattern matches that does not actually reach a row. */
export interface ExcusedSite {
  readonly table: string;
  /** `file#symbol`, exactly as `formatReaderSite` renders it. */
  readonly site: string;
  readonly why: string;
}

/**
 * The census's known false positives, excused BY NAME with a reason.
 *
 * Every one is a consequence of `reviewer_principal_links` being an embedded FIELD
 * rather than a collection: its pattern is a bare word, so any module that merely
 * NAMES the field matches. The narrower alternative — requiring a `.principalLinks`
 * property access — was measured and rejected, because it misses
 * `sortition.service.ts`'s `principalLinks: { $elemMatch: … }`, which is the query
 * that justified extracting the table in the first place. An over-broad pattern
 * produces an entry somebody must explain; a narrow one produces a silent absence.
 *
 * This list is the "explicitly not applicable" half of a total classification: a
 * matching site is either a declared reader or excused here, and being in NEITHER
 * fails. It exists at all because a gate that cries wolf is a gate whoever hits it
 * next switches off — so the false positives are fixed before it becomes a gate,
 * not after.
 *
 * The gate additionally asserts every entry here STILL matches. An excuse for a
 * site that no longer exists is how an exclusion list rots into cover.
 */
export const CENSUS_EXCUSED_SITES: readonly ExcusedSite[] = [
  {
    table: 'reviewer_principal_links',
    site: 'src/db/postgres/tableRegistry.ts#UNSCOPED_TABLES',
    why: 'The registry names the field in an exemption reason. Prose about a table, not a read of it.',
  },
  {
    table: 'reviewer_principal_links',
    site: 'src/db/postgres/collectionReaders.ts#UNSCOPED_TABLE_ACCESSORS',
    why: 'This census’s own accessor map, which must name the field in order to search for it.',
  },
  {
    table: 'reviewer_principal_links',
    site: 'src/modules/trust/crossTenantReads.ts#CROSS_TENANT_FORBIDDEN_FIELDS',
    why: 'A denial list naming the field in order to FORBID projecting it. The opposite of a reader.',
  },
  {
    table: 'reviewer_principal_links',
    site: 'src/modules/reviewer/reviewer.collection.ts#reviewerProfileSchema',
    why: 'The Mongoose schema declaring the embedded array, and the index over it. A definition, not a read.',
  },
  {
    table: 'reviewer_principal_links',
    site: 'src/modules/reviewer/reviewer.collection.ts#<module>',
    why: 'Top-level index declarations over the embedded array, beside the schema above.',
  },
];

/**
 * What the census found for one table that its registry entry did not declare, and
 * the reverse.
 *
 * BOTH directions are reported. An undeclared reader is the leak this exists to
 * catch; a declared reader that no longer exists is a registry that has quietly
 * stopped describing the code, which is how a residual fills with noise until
 * somebody turns the check off.
 */
export interface ReaderCensusResult {
  readonly table: string;
  /** Found in source, neither declared nor excused — every one needs an answer. */
  readonly unattributed: readonly string[];
  /** Declared in the registry, no longer in source. */
  readonly stale: readonly string[];
}

export function censusUnscopedReaders(
  sites: readonly ReaderSite[],
  declared: Readonly<Record<string, readonly string[]>>,
  excused: readonly ExcusedSite[] = CENSUS_EXCUSED_SITES,
): ReaderCensusResult[] {
  return Object.entries(declared).map(([table, expected]) => {
    const found = new Set(
      sites.filter((site) => site.table === table).map((site) => formatReaderSite(site)),
    );
    const declaredSet = new Set(expected);
    const excusedSet = new Set(
      excused.filter((entry) => entry.table === table).map((entry) => entry.site),
    );

    return {
      table,
      unattributed: [...found]
        .filter((reader) => !declaredSet.has(reader) && !excusedSet.has(reader))
        .sort(),
      stale: [...declaredSet].filter((reader) => !found.has(reader)).sort(),
    };
  });
}

/**
 * Excuses that no longer match anything.
 *
 * Reported separately from `stale` because they mean something different: a stale
 * DECLARATION is a reader that went away, while a stale EXCUSE is a suppression
 * still in force over nothing — harmless today and cover for a real site that
 * later lands on the same name.
 */
export function staleExcuses(
  sites: readonly ReaderSite[],
  excused: readonly ExcusedSite[] = CENSUS_EXCUSED_SITES,
): string[] {
  const found = new Set(sites.map((site) => `${site.table}\u0000${formatReaderSite(site)}`));
  return excused
    .filter((entry) => !found.has(`${entry.table}\u0000${entry.site}`))
    .map((entry) => `${entry.table}: ${entry.site}`)
    .sort();
}
