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
