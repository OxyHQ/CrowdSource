import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';

import type { TenantContext, TenantScoped } from './tenantScope';
import { tenantScopedDocument } from './tenantScope';
import { getPostgresDatabase } from './postgres/database';
import * as tables from './postgres/schema';
import {
  type PgHandle,
  type PgTransactionHandle,
  withTenant,
  withTenantTransaction,
} from './postgres/withTenant';
import { newPublicId } from '../utils/identifiers';

/** PostgreSQL/Drizzle document access for the domain services. */
export type TransactionSession = PgTransactionHandle;
export type SortOrder = 1 | -1 | 'asc' | 'desc' | 'ascending' | 'descending';

export interface FindOptions {
  readonly sort?: Record<string, SortOrder>;
  readonly limit?: number;
}

export interface FindOneAndUpdateOptions extends FindOptions {
  readonly upsert?: boolean;
}

export interface TenantScopedUpdate<TStored> {
  readonly set?: Partial<Omit<TStored, keyof TenantContext>>;
  readonly setOnInsert?: Partial<Omit<TStored, keyof TenantContext>>;
  readonly inc?: Readonly<Record<string, number>>;
  readonly max?: Readonly<Record<string, number>>;
  readonly addToSet?: Readonly<Record<string, readonly unknown[]>>;
}

export interface UnscopedRationale {
  readonly why: string;
}

interface DocumentCodec {
  encode(value: Readonly<Record<string, unknown>>): Record<string, unknown>;
  encodeInsert?(value: Readonly<Record<string, unknown>>): Record<string, unknown>;
  decode(value: Readonly<Record<string, unknown>>, db: PgHandle): Promise<Record<string, unknown>>;
}

const identityCodec: DocumentCodec = {
  encode: (value) => ({ ...value }),
  decode: async (value) => ({ ...value }),
};

const omitNullCodec: DocumentCodec = {
  encode: (value) => ({ ...value }),
  decode: async (value) => Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== null),
  ),
};

const organizationMemberCodec: DocumentCodec = {
  encode(value) {
    const { role, ...document } = value;
    return role === undefined ? document : {
      ...document,
      roles: [role],
    };
  },
  encodeInsert(value) {
    return {
      membershipId: value.membershipId ?? newPublicId('membership'),
      ...this.encode(value),
    };
  },
  async decode(value) {
    const { membershipId: _membershipId, roles, ...document } = value;
    return {
      ...document,
      role: Array.isArray(roles) ? roles[0] : undefined,
    };
  },
};

const decisionCodec: DocumentCodec = {
  encode(value) {
    const { jury, policyVersions, ...flat } = value;
    const encoded = { ...flat };
    if (jury && typeof jury === 'object') {
      const row = jury as Readonly<Record<string, unknown>>;
      Object.assign(encoded, {
        jurySize: row.size,
        juryDecisiveVotes: row.decisiveVotes,
        juryWinningVotes: row.winningVotes,
        juryAgreement: row.agreement,
        jurySpecialistPresent: row.specialistPresent,
      });
    }
    if (policyVersions && typeof policyVersions === 'object') {
      const row = policyVersions as Readonly<Record<string, unknown>>;
      Object.assign(encoded, {
        policyVersionTaxonomy: row.taxonomy,
        policyVersionApplication: row.application,
        policyVersionOxyConduct: row.oxyConduct,
      });
    }
    return encoded;
  },
  async decode(value) {
    const {
      jurySize,
      juryDecisiveVotes,
      juryWinningVotes,
      juryAgreement,
      jurySpecialistPresent,
      policyVersionTaxonomy,
      policyVersionApplication,
      policyVersionOxyConduct,
      ...document
    } = value;
    return {
      ...document,
      jury: {
        size: jurySize,
        decisiveVotes: juryDecisiveVotes,
        winningVotes: juryWinningVotes,
        agreement: juryAgreement,
        specialistPresent: jurySpecialistPresent,
      },
      policyVersions: {
        taxonomy: policyVersionTaxonomy,
        application: policyVersionApplication,
        oxyConduct: policyVersionOxyConduct,
      },
    };
  },
};

const reviewerProfileCodec: DocumentCodec = {
  encode(value) {
    const { principalLinks: _principalLinks, ...profile } = value;
    return profile;
  },
  async decode(value, db) {
    const links = await db
      .select({
        applicationId: tables.reviewerPrincipalLinks.applicationId,
        externalPrincipalId: tables.reviewerPrincipalLinks.externalPrincipalId,
      })
      .from(tables.reviewerPrincipalLinks)
      .where(eq(tables.reviewerPrincipalLinks.reviewerId, String(value.reviewerId)));
    return { ...value, principalLinks: links };
  },
};

interface CollectionBinding {
  readonly table: AnyPgTable;
  readonly codec: DocumentCodec;
}

/** Explicit names: no ordering or string derivation decides storage. */
const COLLECTION_BINDINGS: Readonly<Record<string, CollectionBinding>> = {
  Appeal: { table: tables.appeals, codec: identityCodec },
  Application: { table: tables.applications, codec: identityCodec },
  ApplicationCredential: { table: tables.applicationCredentials, codec: identityCodec },
  ApplicationTrust: { table: tables.appTrustSnapshots, codec: identityCodec },
  Assignment: { table: tables.assignments, codec: identityCodec },
  AuditEvent: { table: tables.auditEvents, codec: identityCodec },
  Case: { table: tables.cases, codec: identityCodec },
  CaseReport: { table: tables.caseReports, codec: identityCodec },
  Decision: { table: tables.decisions, codec: decisionCodec },
  Organization: { table: tables.organizations, codec: identityCodec },
  OrganizationMember: { table: tables.organizationMembers, codec: organizationMemberCodec },
  OutboxEvent: { table: tables.outboxEvents, codec: identityCodec },
  PolicySet: { table: tables.policySets, codec: omitNullCodec },
  Report: { table: tables.reports, codec: identityCodec },
  Review: { table: tables.reviews, codec: identityCodec },
  ReviewerAffinity: { table: tables.reviewerAffinities, codec: identityCodec },
  ReviewerProfile: { table: tables.reviewerProfiles, codec: reviewerProfileCodec },
  ReviewerRelation: { table: tables.reviewerRelations, codec: identityCodec },
  SortitionDraw: { table: tables.sortitionDraws, codec: identityCodec },
  StaffAuditEvent: { table: tables.staffAuditEvents, codec: identityCodec },
  TrustSafetyStaff: { table: tables.trustSafetyStaff, codec: identityCodec },
  UsageCounter: { table: tables.usageCounters, codec: identityCodec },
  WebhookAttempt: { table: tables.webhookAttempts, codec: identityCodec },
  WebhookDelivery: { table: tables.webhookDeliveries, codec: identityCodec },
  WebhookEndpoint: { table: tables.webhookEndpoints, codec: identityCodec },
  WebhookSecret: { table: tables.webhookSecrets, codec: identityCodec },
};

const registered: string[] = [];
const unscopedRationales = new Map<string, string>();

function bindingFor(name: string): CollectionBinding {
  const binding = COLLECTION_BINDINGS[name];
  if (!binding) throw new Error(`No PostgreSQL table is registered for '${name}'.`);
  return binding;
}

function columnsFor(table: AnyPgTable): Record<string, AnyPgColumn> {
  return getTableColumns(table) as Record<string, AnyPgColumn>;
}

function tableName(table: AnyPgTable): string {
  return String(Reflect.get(table, Symbol.for('drizzle:Name')) ?? '(unknown table)');
}

function columnFor(table: AnyPgTable, key: string): AnyPgColumn {
  const aliases: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    organization_members: { role: 'roles' },
  };
  const storedKey = aliases[tableName(table)]?.[key] ?? key;
  const column = columnsFor(table)[storedKey];
  if (!column) throw new Error(`Unknown field '${key}' on PostgreSQL table '${tableName(table)}'.`);
  return column;
}

function isOperatorObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !(value instanceof Date) && !Array.isArray(value);
}

function comparison(column: AnyPgColumn | SQL, expected: unknown): SQL {
  // Drizzle's overloads cannot express a helper that accepts either a real
  // column or a derived JSON expression. Keep the original object so real
  // columns retain their encoder (timestamps and arrays depend on it); the cast
  // only resolves the overload and does not wrap or rewrite the SQL at runtime.
  const expression = column as AnyPgColumn;
  if (expected instanceof RegExp) {
    const prefix = /^\^([A-Za-z0-9_-]+)$/.exec(expected.source)?.[1];
    if (prefix === undefined || expected.flags !== '') {
      throw new Error(`Unsupported PostgreSQL regular expression filter '${expected}'.`);
    }
    const escaped = prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
    return like(expression, `${escaped}%`);
  }
  if (!isOperatorObject(expected) || !Object.keys(expected).some((key) => key.startsWith('$'))) {
    if (Reflect.get(column, 'dataType') === 'array' && !Array.isArray(expected)) {
      return arrayContains(expression, [expected]);
    }
    return expected === null ? isNull(expression) : eq(expression, expected);
  }
  const parts: SQL[] = [];
  for (const [operator, operand] of Object.entries(expected)) {
    switch (operator) {
      case '$in':
        parts.push(Array.isArray(operand) && operand.length > 0 ? inArray(expression, operand) : sql`false`);
        break;
      case '$nin':
        parts.push(Array.isArray(operand) && operand.length > 0 ? notInArray(expression, operand) : sql`true`);
        break;
      case '$ne':
        parts.push(operand === null ? isNotNull(expression) : ne(expression, operand));
        break;
      case '$gt': parts.push(gt(expression, operand)); break;
      case '$gte': parts.push(gte(expression, operand)); break;
      case '$lt': parts.push(lt(expression, operand)); break;
      case '$lte': parts.push(lte(expression, operand)); break;
      case '$all':
        parts.push(Array.isArray(operand) && operand.length > 0 ? arrayContains(expression, operand) : sql`false`);
        break;
      case '$not': parts.push(not(comparison(column, operand))); break;
      default: throw new Error(`Unsupported PostgreSQL filter operator '${operator}'.`);
    }
  }
  return and(...parts) ?? sql`true`;
}

function whereFor(table: AnyPgTable, filter: Readonly<Record<string, unknown>>): SQL {
  const parts: SQL[] = [];
  for (const [field, expected] of Object.entries(filter)) {
    if (field === '$or' || field === '$and') {
      if (!Array.isArray(expected)) throw new Error(`'${field}' must be an array.`);
      const nested = expected.map((entry) => {
        if (!isOperatorObject(entry)) throw new Error(`'${field}' entries must be objects.`);
        return whereFor(table, entry);
      });
      parts.push(field === '$or' ? (or(...nested) ?? sql`false`) : (and(...nested) ?? sql`true`));
    } else {
      const [root, nested, ...rest] = field.split('.');
      if (!root || rest.length > 0) {
        throw new Error(`Unsupported nested PostgreSQL field '${field}'.`);
      }
      const column = columnFor(table, root);
      if (nested === undefined) {
        parts.push(comparison(column, expected));
      } else {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nested) || Reflect.get(column, 'dataType') !== 'json') {
          throw new Error(`Unsupported nested PostgreSQL field '${field}'.`);
        }
        parts.push(comparison(sql`${column} ->> ${nested}`, expected));
      }
    }
  }
  return and(...parts) ?? sql`true`;
}

function orderFor(table: AnyPgTable, sort: Readonly<Record<string, SortOrder>> | undefined): SQL[] {
  if (!sort) return [];
  return Object.entries(sort).map(([field, direction]) =>
    direction === -1 || direction === 'desc' || direction === 'descending'
      ? desc(columnFor(table, field))
      : asc(columnFor(table, field)),
  );
}

async function decodeMany<TStored>(codec: DocumentCodec, rows: readonly Readonly<Record<string, unknown>>[], db: PgHandle): Promise<TStored[]> {
  return await Promise.all(rows.map(async (row) => (await codec.decode(row, db)) as TStored));
}

function encodeUpdate(codec: DocumentCodec, update: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const encoded = codec.encode(update);
  if (Object.keys(encoded).length === 0) throw new Error('A PostgreSQL update cannot be empty.');
  return encoded;
}

export class TenantCollection<TStored extends TenantContext> {
  readonly name: string;
  readonly #binding: CollectionBinding;

  constructor(name: string) {
    this.name = name;
    this.#binding = bindingFor(name);
  }

  async #run<T>(context: TenantContext, session: TransactionSession | undefined, operation: (db: PgHandle) => Promise<T>): Promise<T> {
    return session
      ? withTenantTransaction(session, context, operation)
      : withTenant(getPostgresDatabase(), context, operation);
  }

  async insertOne(context: TenantContext, document: Omit<TStored, keyof TenantContext>, session?: TransactionSession): Promise<TenantScoped<Omit<TStored, keyof TenantContext>>> {
    const scoped = tenantScopedDocument(context, document);
    await this.#run(context, session, async (db) => {
      await db.insert(this.#binding.table).values(
        this.#binding.codec.encodeInsert?.(scoped) ?? this.#binding.codec.encode(scoped),
      );
    });
    return scoped;
  }

  async findOne(context: TenantContext, filter: Readonly<Record<string, unknown>> = {}): Promise<TStored | null> {
    return this.#run(context, undefined, async (db) => {
      const rows = await db.select().from(this.#binding.table).where(whereFor(this.#binding.table, filter)).limit(1);
      const decoded = await decodeMany<TStored>(this.#binding.codec, rows, db);
      return decoded[0] ?? null;
    });
  }

  async find(context: TenantContext, filter: Readonly<Record<string, unknown>> = {}, options: FindOptions = {}): Promise<TStored[]> {
    return this.#run(context, undefined, async (db) => {
      const query = db.select().from(this.#binding.table).where(whereFor(this.#binding.table, filter)).$dynamic();
      const ordering = orderFor(this.#binding.table, options.sort);
      if (ordering.length > 0) query.orderBy(...ordering);
      if (options.limit !== undefined) query.limit(options.limit);
      return decodeMany<TStored>(this.#binding.codec, await query, db);
    });
  }

  async countDocuments(context: TenantContext, filter: Readonly<Record<string, unknown>> = {}): Promise<number> {
    return this.#run(context, undefined, async (db) => {
      const [row] = await db.select({ count: sql<number>`count(*)::integer` }).from(this.#binding.table).where(whereFor(this.#binding.table, filter));
      return row?.count ?? 0;
    });
  }

  async updateOne(context: TenantContext, filter: Readonly<Record<string, unknown>>, update: TenantScopedUpdate<TStored>, session?: TransactionSession): Promise<number> {
    const { set = {}, inc = {}, max = {}, addToSet = {}, setOnInsert } = update;
    if (setOnInsert !== undefined) throw new Error(`'${this.name}' requires its dedicated PostgreSQL upsert repository.`);
    const patch: Record<string, unknown> = { ...set };
    for (const [field, amount] of Object.entries(inc)) patch[field] = sql`${columnFor(this.#binding.table, field)} + ${amount}`;
    for (const [field, value] of Object.entries(max)) patch[field] = sql`greatest(${columnFor(this.#binding.table, field)}, ${value})`;
    for (const [field, values] of Object.entries(addToSet)) patch[field] = sql`array(select distinct unnest(${columnFor(this.#binding.table, field)} || ${[...values]}))`;
    return this.#run(context, session, async (db) => {
      const rows = await db.update(this.#binding.table).set(encodeUpdate(this.#binding.codec, patch)).where(whereFor(this.#binding.table, filter)).returning({ marker: sql<number>`1` });
      return rows.length;
    });
  }

  async upsertOne(
    _context: TenantContext,
    _filter: Readonly<Record<string, unknown>>,
    _update: TenantScopedUpdate<TStored>,
    _session?: TransactionSession,
  ): Promise<TStored> {
    throw new Error(`'${this.name}' requires its dedicated PostgreSQL upsert repository.`);
  }
}

export class UnscopedCollection<TStored> {
  readonly name: string;
  readonly why: string;
  readonly #binding: CollectionBinding;

  constructor(name: string, rationale: UnscopedRationale) {
    this.name = name;
    this.why = rationale.why;
    this.#binding = bindingFor(name);
  }

  #db(session?: TransactionSession): PgHandle { return session ?? getPostgresDatabase(); }

  async insertOne(document: TStored, session?: TransactionSession): Promise<TStored> {
    const raw = document as Readonly<Record<string, unknown>>;
    const insert = async (db: PgHandle): Promise<void> => {
      await db.insert(this.#binding.table).values(
        this.#binding.codec.encodeInsert?.(raw) ?? this.#binding.codec.encode(raw),
      );
      if (this.name === 'ReviewerProfile') {
        const reviewerId = String(raw.reviewerId);
        const links = raw.principalLinks;
        if (Array.isArray(links) && links.length > 0) {
          await db.insert(tables.reviewerPrincipalLinks).values(
            links.map((entry) => {
              if (!entry || typeof entry !== 'object') {
                throw new Error('Reviewer principal links must be objects.');
              }
              const link = entry as Readonly<Record<string, unknown>>;
              return {
                reviewerId,
                applicationId: String(link.applicationId),
                externalPrincipalId: String(link.externalPrincipalId),
              };
            }),
          );
        }
      }
    };
    if (session) await insert(session);
    else await getPostgresDatabase().transaction(insert);
    return document;
  }

  async findOne(filter: Readonly<Record<string, unknown>>): Promise<TStored | null> {
    const db = this.#db();
    const rows = await db.select().from(this.#binding.table).where(whereFor(this.#binding.table, filter)).limit(1);
    const decoded = await decodeMany<TStored>(this.#binding.codec, rows, db);
    return decoded[0] ?? null;
  }

  async find(filter: Readonly<Record<string, unknown>>, options: FindOptions = {}): Promise<TStored[]> {
    const db = this.#db();
    const query = db.select().from(this.#binding.table).where(whereFor(this.#binding.table, filter)).$dynamic();
    const ordering = orderFor(this.#binding.table, options.sort);
    if (ordering.length > 0) query.orderBy(...ordering);
    if (options.limit !== undefined) query.limit(options.limit);
    return decodeMany<TStored>(this.#binding.codec, await query, db);
  }

  async countDocuments(filter: Readonly<Record<string, unknown>> = {}): Promise<number> {
    const [row] = await this.#db().select({ count: sql<number>`count(*)::integer` }).from(this.#binding.table).where(whereFor(this.#binding.table, filter));
    return row?.count ?? 0;
  }

  async updateOne(filter: Readonly<Record<string, unknown>>, update: Readonly<Record<string, unknown>>, session?: TransactionSession): Promise<number> {
    const rows = await this.#db(session).update(this.#binding.table).set(encodeUpdate(this.#binding.codec, update)).where(whereFor(this.#binding.table, filter)).returning({ marker: sql<number>`1` });
    return rows.length;
  }

  async findOneAndUpdate(
    _filter: Readonly<Record<string, unknown>>,
    _update: Readonly<Record<string, unknown>>,
    _options: FindOneAndUpdateOptions = {},
    _session?: TransactionSession,
  ): Promise<TStored | null> {
    throw new Error(`'${this.name}' requires its dedicated PostgreSQL claim/update repository.`);
  }
}

export function defineTenantCollection<TStored extends TenantContext>(name: string): TenantCollection<TStored> {
  const collection = new TenantCollection<TStored>(name);
  registered.push(name);
  return collection;
}

export function defineUnscopedCollection<TStored>(name: string, rationale: UnscopedRationale): UnscopedCollection<TStored> {
  const collection = new UnscopedCollection<TStored>(name, rationale);
  registered.push(name);
  unscopedRationales.set(name, rationale.why);
  return collection;
}

export function registeredCollectionNames(): readonly string[] { return [...registered]; }
export function unscopedCollectionReasons(): ReadonlyMap<string, string> { return new Map(unscopedRationales); }
