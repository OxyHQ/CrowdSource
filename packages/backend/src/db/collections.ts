import mongoose, {
  type ClientSession,
  type RootFilterQuery,
  type Model,
  type Schema,
  type SortOrder,
  type UpdateQuery,
} from 'mongoose';

import {
  isScopedToTenant,
  type TenantContext,
  type TenantScoped,
  tenantScopedDocument,
  tenantScopedFilter,
} from './tenantScope';

/**
 * The only way this service reaches a collection.
 *
 * `tenantScope.ts` states the rule; this file is what makes following it the
 * path of least resistance. A collection is declared here, the Mongoose model
 * it wraps is a `#private` field, and the module that declares it exports the
 * wrapper rather than the model — so a query that forgets the tenant filter is
 * not something a caller can write by accident. It has to be reached for:
 * `mongoose.model('Report')` off the global registry is the one remaining door,
 * and `collectionBoundary.test.ts` fails the build when a module outside this
 * directory walks through it.
 *
 * Two kinds of collection exist, and the difference is the whole point:
 *
 *  - `defineTenantCollection` — tenant-OWNED data (reports, cases, reviews).
 *    Every read and write takes a `TenantContext` and is filtered by it. There
 *    is no unfiltered method to call.
 *  - `defineUnscopedCollection` — the few collections that cannot be scoped by
 *    the tenant because they DEFINE it (organizations, applications,
 *    credentials) or are read across tenants by infrastructure (the outbox
 *    dispatcher). Each one states, in source, why it is exempt; the boundary
 *    test asserts the exact set, so a new exemption cannot appear quietly.
 */

/** A collection that can create its own indexes. */
interface RegisteredCollection {
  readonly name: string;
  ensureIndexes(): Promise<void>;
}

/** How many documents a scoped read may return, and in what order. */
export interface FindOptions {
  readonly sort?: Record<string, SortOrder>;
  readonly limit?: number;
}

/**
 * The update operators a tenant-owned write may use, as a restricted spec
 * rather than a raw Mongo update document.
 *
 * A raw `UpdateQuery` accepts `$set: { applicationId: … }` and would move a
 * document between tenants — the same mass-assignment hole `tenantScopedDocument`
 * closes on insert, reopened on update. Here the caller names fields, the
 * operators are a closed set, and the tenant keys are rejected on the way
 * through, so the only writer of a tenant key remains the access layer.
 */
export interface TenantScopedUpdate<TStored> {
  readonly set?: Partial<Omit<TStored, keyof TenantContext>>;
  /** Applied only when an upsert creates the document. */
  readonly setOnInsert?: Partial<Omit<TStored, keyof TenantContext>>;
  readonly inc?: Readonly<Record<string, number>>;
  /** Keeps the larger of the stored and supplied values. Creates on insert. */
  readonly max?: Readonly<Record<string, number>>;
  readonly addToSet?: Readonly<Record<string, readonly unknown[]>>;
}

/** Builds the Mongo update document, refusing any attempt to write a tenant key. */
function tenantScopedUpdateDocument<TStored>(
  spec: TenantScopedUpdate<TStored>,
): UpdateQuery<TStored> {
  const update: Record<string, unknown> = {};
  const operators: readonly [keyof TenantScopedUpdate<TStored>, string][] = [
    ['set', '$set'],
    ['setOnInsert', '$setOnInsert'],
    ['inc', '$inc'],
    ['max', '$max'],
    ['addToSet', '$addToSet'],
  ];

  for (const [field, operator] of operators) {
    const value = spec[field];
    if (value === undefined) continue;
    assertNoTenantKeys(value, `A tenant-scoped '${operator}'`);
    update[operator] = value;
  }

  if (Object.keys(update).length === 0) {
    throw new Error('A tenant-scoped update must name at least one operator.');
  }
  return update as UpdateQuery<TStored>;
}

/**
 * Rejects a tenant key wherever a caller could supply one.
 *
 * Duplicated from `tenantScope.ts` rather than exported from it, because the
 * two guard different things: that module guards filters and documents, this
 * one guards update operators, and an update operator payload is not a document.
 */
function assertNoTenantKeys(subject: object, what: string): void {
  for (const key of ['organizationId', 'applicationId']) {
    if (Object.prototype.hasOwnProperty.call(subject, key)) {
      throw new Error(
        `${what} must not set '${key}'; the tenant comes from the credential, never from the caller.`,
      );
    }
  }
}

const registered: RegisteredCollection[] = [];

/**
 * Why a collection is not tenant-scoped. Required, and read by the boundary
 * test: an exemption without a stated reason is how the rule erodes.
 */
export interface UnscopedRationale {
  readonly why: string;
}

const unscopedRationales = new Map<string, string>();

/**
 * Registers a Mongoose model, tolerating a module reset.
 *
 * Vitest reuses a worker process across test files while resetting the module
 * registry, so a model name can be declared twice against the same Mongoose
 * instance. Replacing the previous registration keeps the schema authoritative;
 * throwing `OverwriteModelError` would make suite order decide whether the tests
 * run at all.
 */
function registerModel<TStored>(name: string, schema: Schema<TStored>): Model<TStored> {
  if (mongoose.models[name]) {
    mongoose.deleteModel(name);
  }
  return mongoose.model<TStored>(name, schema);
}

/**
 * A tenant-owned collection. Every operation requires the tenant context, and
 * the context — not the caller's filter — decides which rows are visible.
 */
export class TenantCollection<TStored extends TenantContext> {
  readonly #model: Model<TStored>;
  readonly name: string;

  constructor(name: string, schema: Schema<TStored>) {
    this.name = name;
    this.#model = registerModel(name, schema);
  }

  /**
   * Inserts one document, stamped with the owning tenant.
   *
   * The caller passes an explicit field list — never a spread request body —
   * and cannot pass the tenant keys at all: `tenantScopedDocument` throws on
   * them. Mass assignment therefore has no route in.
   */
  async insertOne(
    context: TenantContext,
    document: Omit<TStored, keyof TenantContext>,
    session?: ClientSession,
  ): Promise<TenantScoped<Omit<TStored, keyof TenantContext>>> {
    const scoped = tenantScopedDocument(context, document);
    await this.#model.create([scoped], { session });
    return scoped;
  }

  /** Finds one document belonging to this tenant, or null. */
  async findOne(
    context: TenantContext,
    filter: RootFilterQuery<TStored> & object = {},
  ): Promise<TStored | null> {
    return this.#model.findOne(tenantScopedFilter(context, filter)).lean<TStored>().exec();
  }

  /** Finds every document belonging to this tenant that matches. */
  async find(
    context: TenantContext,
    filter: RootFilterQuery<TStored> & object = {},
    options: FindOptions = {},
  ): Promise<TStored[]> {
    const query = this.#model.find(tenantScopedFilter(context, filter));
    if (options.sort) query.sort(options.sort);
    if (options.limit !== undefined) query.limit(options.limit);
    return query.lean<TStored[]>().exec();
  }

  /** Counts documents belonging to this tenant. */
  async countDocuments(
    context: TenantContext,
    filter: RootFilterQuery<TStored> & object = {},
  ): Promise<number> {
    return this.#model.countDocuments(tenantScopedFilter(context, filter)).exec();
  }

  /** Applies a restricted update to one document of this tenant. */
  async updateOne(
    context: TenantContext,
    filter: RootFilterQuery<TStored> & object,
    update: TenantScopedUpdate<TStored>,
    session?: ClientSession,
  ): Promise<number> {
    const result = await this.#model
      .updateOne(tenantScopedFilter(context, filter), tenantScopedUpdateDocument(update), {
        session,
      })
      .exec();
    return result.modifiedCount;
  }

  /**
   * Creates the matching document or updates it, and returns the result.
   *
   * This is how a case is deduplicated: the unique compound index is the
   * arbiter, and an upsert either finds the existing case or creates it. A
   * "read, then decide whether to insert" sequence races — two reports about the
   * same post arriving together both read nothing and both create a case, which
   * is two cases and, eventually, two penalties for one incident.
   *
   * The tenant keys are NOT written by the caller here: MongoDB builds an
   * upsert's base document from the equality clauses of the query, and
   * `tenantScopedFilter` guarantees those include the tenant. The assertion
   * afterwards is what makes that a checked property rather than a belief about
   * driver behaviour.
   */
  async upsertOne(
    context: TenantContext,
    filter: RootFilterQuery<TStored> & object,
    update: TenantScopedUpdate<TStored>,
    session?: ClientSession,
  ): Promise<TStored> {
    const document = await this.#model
      .findOneAndUpdate(
        tenantScopedFilter(context, filter),
        tenantScopedUpdateDocument(update),
        { upsert: true, returnDocument: 'after', session },
      )
      .lean<TStored>()
      .exec();

    return assertUpsertedIntoTenant(this.name, context, document);
  }

  async ensureIndexes(): Promise<void> {
    await this.#model.createIndexes();
  }
}

/**
 * A collection the tenant filter cannot apply to. Declaring one is a deliberate
 * act that has to justify itself and that the boundary test counts.
 */
export class UnscopedCollection<TStored> {
  readonly #model: Model<TStored>;
  readonly name: string;
  readonly why: string;

  constructor(name: string, schema: Schema<TStored>, rationale: UnscopedRationale) {
    this.name = name;
    this.why = rationale.why;
    this.#model = registerModel(name, schema);
  }

  async insertOne(document: TStored, session?: ClientSession): Promise<TStored> {
    await this.#model.create([document], { session });
    return document;
  }

  async findOne(filter: RootFilterQuery<TStored> & object): Promise<TStored | null> {
    return this.#model.findOne(filter).lean<TStored>().exec();
  }

  async find(
    filter: RootFilterQuery<TStored> & object,
    options: FindOptions = {},
  ): Promise<TStored[]> {
    const query = this.#model.find(filter);
    if (options.sort) query.sort(options.sort);
    if (options.limit !== undefined) query.limit(options.limit);
    return query.lean<TStored[]>().exec();
  }

  /**
   * Claims or mutates one document atomically.
   *
   * The restricted update spec that guards tenant-owned writes does not apply
   * here, and does not need to: an unscoped collection has no tenant filter to
   * forget, so the caller states the whole filter and there is no implicit scope
   * for an operator to escape. What this IS used for is the outbox dispatcher's
   * claim — find one pending row and mark it in flight in a single operation,
   * so two dispatcher instances cannot both take it.
   */
  async findOneAndUpdate(
    filter: RootFilterQuery<TStored> & object,
    update: UpdateQuery<TStored>,
    options: FindOptions = {},
  ): Promise<TStored | null> {
    return this.#model
      .findOneAndUpdate(filter, update, {
        returnDocument: 'after',
        ...(options.sort ? { sort: options.sort } : {}),
      })
      .lean<TStored>()
      .exec();
  }

  async updateOne(
    filter: RootFilterQuery<TStored> & object,
    update: Readonly<Record<string, unknown>>,
    session?: ClientSession,
  ): Promise<number> {
    const result = await this.#model.updateOne(filter, { $set: update }, { session }).exec();
    return result.modifiedCount;
  }

  async ensureIndexes(): Promise<void> {
    await this.#model.createIndexes();
  }
}

/**
 * The postconditions of an upsert, as a function so they can be exercised.
 *
 * Neither is reachable through the driver in normal operation — an upsert with
 * `returnDocument: 'after'` always returns a document, and the tenant comes from
 * the filter — which is exactly why they are worth stating: the second one is
 * the assertion that MongoDB really does build an upsert's base document from
 * the query's equality clauses, rather than that being a belief about driver
 * behaviour nobody ever checks.
 */
export function assertUpsertedIntoTenant<TStored extends object>(
  collectionName: string,
  context: TenantContext,
  document: TStored | null,
): TStored {
  if (document === null) {
    throw new Error(`An upsert on '${collectionName}' returned no document.`);
  }
  if (!isScopedToTenant(context, document)) {
    throw new Error(
      `An upsert on '${collectionName}' produced a document outside the requesting tenant.`,
    );
  }
  return document;
}

/** Declares a tenant-owned collection. */
export function defineTenantCollection<TStored extends TenantContext>(
  name: string,
  schema: Schema<TStored>,
): TenantCollection<TStored> {
  const collection = new TenantCollection(name, schema);
  registered.push(collection);
  return collection;
}

/** Declares a collection the tenant filter cannot apply to, with its reason. */
export function defineUnscopedCollection<TStored>(
  name: string,
  schema: Schema<TStored>,
  rationale: UnscopedRationale,
): UnscopedCollection<TStored> {
  const collection = new UnscopedCollection(name, schema, rationale);
  registered.push(collection);
  unscopedRationales.set(name, rationale.why);
  return collection;
}

/**
 * Creates every declared index.
 *
 * Idempotency is not application logic here — it is a unique index (§12.7). A
 * deployment whose indexes were never built accepts duplicate reports, duplicate
 * reviews and duplicate reputation effects while reporting perfect health, so
 * index creation is part of starting up rather than an operational afterthought.
 *
 * `createIndexes` only ever adds. `syncIndexes` would also DROP anything not in
 * the current schema, which on a rolling deploy means the previous task version
 * loses an index the new one has not finished building.
 */
export async function ensureIndexes(): Promise<void> {
  for (const collection of registered) {
    await collection.ensureIndexes();
  }
}

/** Every declared collection name, in declaration order. */
export function registeredCollectionNames(): readonly string[] {
  return registered.map((collection) => collection.name);
}

/** The collections exempt from tenant scoping, and why. Read by the boundary test. */
export function unscopedCollectionReasons(): ReadonlyMap<string, string> {
  return new Map(unscopedRationales);
}
