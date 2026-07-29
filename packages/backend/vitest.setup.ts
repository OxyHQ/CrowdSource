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
