/**
 * The single source of truth for which database this service writes to.
 *
 * This is a source-level declaration rather than configuration BECAUSE of how
 * Mongoose resolves the target: `mongoose.connect(uri, { dbName })` hands
 * `dbName` to the driver, and `node-mongodb-native/connection.js` does
 * `const db = dbName != null ? client.db(dbName) : client.db()` — a supplied
 * `dbName` OVERRIDES the database named in the connection URI. No value of
 * `MONGODB_URI` can redirect this service, so the connection string is not the
 * thing to guard. The value below is.
 *
 * CrowdSource shares one MongoDB instance with the other Oxy backends, so a
 * wrong value here does not fail to connect — it silently reads and writes
 * another product's live data.
 *
 * `.github/scripts/assert-own-database.sh` reads this declaration before a
 * release is built, and `.github/scripts/test-assert-own-database.sh`
 * mutation-tests that guard. Moving or renaming this declaration means updating
 * all three in the same change.
 */
const DATABASE_NAME = 'crowdsource';

/**
 * The database this service uses for a given runtime environment. This is the
 * value passed to Mongoose as `dbName`, so it — not the URI — decides what a
 * release touches.
 */
export function databaseName(nodeEnv: string): string {
  return `${DATABASE_NAME}-${nodeEnv}`;
}
