import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { databaseName } from '../config/databaseIdentity';
import { connectToDatabase, disconnectFromDatabase } from '../utils/database';

afterEach(async () => {
  vi.restoreAllMocks();
  await disconnectFromDatabase().catch(() => undefined);
});

describe('database identity', () => {
  it('names the database per runtime environment', () => {
    expect(databaseName('production')).toBe('crowdsource-production');
    expect(databaseName('development')).toBe('crowdsource-development');
    expect(databaseName('test')).toBe('crowdsource-test');
  });

  /**
   * The guard in .github/scripts/assert-own-database.sh reads the declaration
   * this test covers. That guard is worth nothing if the connection does not
   * actually use the declared value, so assert the wiring, not just the string:
   * a future author who hardcodes a dbName at the call site fails here.
   */
  it('passes the declared database name to mongoose as dbName', async () => {
    const connect = vi
      .spyOn(mongoose, 'connect')
      .mockResolvedValue(mongoose as unknown as typeof mongoose);

    await connectToDatabase();

    expect(connect).toHaveBeenCalledTimes(1);
    const [uri, options] = connect.mock.calls[0];
    expect(uri).toBe(process.env.MONGODB_URI);
    expect(options?.dbName).toBe(databaseName('test'));
  });

  it('refuses to connect without a configured URI', async () => {
    const connect = vi.spyOn(mongoose, 'connect');
    vi.stubEnv('MONGODB_URI', '');
    vi.resetModules();
    const freshDatabase = await import('../utils/database');

    await expect(freshDatabase.connectToDatabase()).rejects.toThrow(/MONGODB_URI is not defined/);
    expect(connect).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
