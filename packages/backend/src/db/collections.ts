import mongoose, { type ClientSession, type RootFilterQuery, type Model, type Schema } from 'mongoose';

import {
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

  /** Counts documents belonging to this tenant. */
  async countDocuments(
    context: TenantContext,
    filter: RootFilterQuery<TStored> & object = {},
  ): Promise<number> {
    return this.#model.countDocuments(tenantScopedFilter(context, filter)).exec();
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
