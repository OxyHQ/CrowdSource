/**
 * Every table this service owns, in one barrel.
 *
 * drizzle-kit reads this to generate migrations and `createDatabase` reads it to
 * build the query handle, so a table missing from here is one that exists in
 * TypeScript and in no migration — which fails at runtime rather than at build
 * time. The Postgres replacement for `collectionBoundary.test.ts` enumerates this
 * DIRECTORY from the filesystem instead of trusting the barrel, for the reason
 * that gate exists at all: a hand-maintained list of modules is exactly what hid
 * `Decision` and `Appeal` from the Mongo registry.
 */
export * from './cases';
