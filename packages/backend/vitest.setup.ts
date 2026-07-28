/**
 * The suite exercises the connection wiring with a mocked driver, so a URI must
 * exist for `connectToDatabase` to get as far as calling it. It points at
 * nothing: no test opens a real socket, and the database this service uses is
 * decided by `databaseIdentity`, not by this value.
 */
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/unused-by-design';
