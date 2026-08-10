/**
 * `vitest.globalSetup.ts` starts a MongoDB replica set and points `MONGODB_URI`
 * at it before any worker forks, so this assignment is a fallback: the
 * connection-wiring tests mock the driver and never open a socket, but they
 * still need a syntactically valid URI to get as far as calling it.
 *
 * The DATABASE this service uses is decided by `databaseIdentity`, not by this
 * value — see that file for why the URI is not the thing to guard.
 */
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/unused-by-design';

/**
 * `DATABASE_URL` is required to boot, so `config` throws at import without it
 * and every test file in the suite imports `config` transitively.
 *
 * This value is never dialled and is not the database the real-database tests
 * use: each of those creates its own throwaway database and builds its own
 * handle against it (`support/postgresTestDatabase.ts`), connecting as an
 * unprivileged application role, which is the only shape that measures a policy
 * rather than a bypass. What this satisfies is the boot-time REQUIREMENT, and it
 * is deliberately pointed at a database name that says so — a test that reached
 * it would be reaching for the wrong handle.
 */
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused-by-design';

/**
 * A disposable key for the webhook secret cipher (§13.4).
 *
 * `config` is validated once at import time and the real key is a deployment
 * secret, so it has to be present before any module reads it. This value is a
 * fixed 32 bytes of hex and is not a secret in any sense: it encrypts nothing
 * that outlives a test database. The tests that exercise the UNCONFIGURED path
 * do it by stubbing the config field, not by unsetting this.
 */
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ??=
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

/**
 * The reviewer surface answers `503` when no Oxy API is configured, which is the
 * correct production behaviour and would make every reviewer test assert that
 * instead of what it is about. The value is never dialled: the integration tests
 * replace `createOptionalOxyAuth` with a stub, so session VERIFICATION is out of
 * scope here — it belongs to `@oxyhq/core` — while the authorisation this
 * service actually owns is exercised for real.
 */
process.env.OXY_API_URL ??= 'https://api.oxy.invalid';
