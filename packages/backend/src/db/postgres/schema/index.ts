/**
 * Every table this service owns, in one barrel.
 *
 * drizzle-kit reads this to generate migrations and `createDatabase` reads it to
 * build the query handle, so a table missing from here is one that exists in
 * TypeScript and in no migration — which fails at runtime rather than at build
 * time. `postgresTableBoundary.realdb.test.ts` enumerates this DIRECTORY from
 * the filesystem instead of trusting the barrel, because a hand-maintained list
 * of modules is exactly what once hid `Decision` and `Appeal` from a registry.
 */
export * from './accountErasure';
export * from './cases';
export * from './communityNotes';
export * from './console';
export * from './decisions';
export * from './governance';
export * from './infrastructure';
export * from './reports';
export * from './reviewers';
export * from './sortition';
export * from './tenancy';
export * from './webhooks';
