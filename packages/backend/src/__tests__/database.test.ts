import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The connection module keeps process-level state (the in-flight attempt), so
 * each case imports it fresh rather than inheriting another case's.
 */
async function freshDatabaseModule() {
  vi.resetModules();
  return import('../utils/database');
}

/** `readyState` is a prototype getter; override it as an own property. */
function stubReadyState(value: number): void {
  Object.defineProperty(mongoose.connection, 'readyState', {
    value,
    configurable: true,
  });
}

function restoreReadyState(): void {
  delete (mongoose.connection as unknown as Record<string, unknown>).readyState;
}

beforeEach(() => {
  stubReadyState(0);
});

afterEach(() => {
  restoreReadyState();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('connectToDatabase', () => {
  it('retries a failed attempt with backoff and succeeds', async () => {
    vi.useFakeTimers();
    const connect = vi
      .spyOn(mongoose, 'connect')
      .mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce(mongoose as unknown as typeof mongoose);

    const database = await freshDatabaseModule();
    const pending = database.connectToDatabase();

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(mongoose);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of attempts and rethrows', async () => {
    vi.useFakeTimers();
    vi.stubEnv('MONGODB_MAX_RETRIES', '2');
    const connect = vi
      .spyOn(mongoose, 'connect')
      .mockRejectedValue(Object.assign(new Error('refused'), { syscall: 'connect' }));

    const database = await freshDatabaseModule();
    const pending = database.connectToDatabase();
    const assertion = expect(pending).rejects.toThrow(/refused/);

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect when a connection is already open', async () => {
    const connect = vi.spyOn(mongoose, 'connect');
    stubReadyState(1);

    const database = await freshDatabaseModule();
    await expect(database.connectToDatabase()).resolves.toBe(mongoose);

    expect(connect).not.toHaveBeenCalled();
    expect(database.isDatabaseConnected()).toBe(true);
  });

  it('shares one attempt between concurrent callers', async () => {
    const connect = vi
      .spyOn(mongoose, 'connect')
      .mockResolvedValue(mongoose as unknown as typeof mongoose);

    const database = await freshDatabaseModule();
    await Promise.all([database.connectToDatabase(), database.connectToDatabase()]);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  /**
   * A resolved attempt must not be cached forever: after a disconnect the next
   * caller has to start a new one, or the process stays down until it restarts.
   */
  it('starts a new attempt after a disconnect', async () => {
    const connect = vi
      .spyOn(mongoose, 'connect')
      .mockResolvedValue(mongoose as unknown as typeof mongoose);
    const disconnect = vi.spyOn(mongoose, 'disconnect').mockResolvedValue();

    const database = await freshDatabaseModule();
    await database.connectToDatabase();
    await database.disconnectFromDatabase();
    await database.connectToDatabase();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('reports connection state from the live driver', async () => {
    const database = await freshDatabaseModule();

    stubReadyState(1);
    expect(database.isDatabaseConnected()).toBe(true);
    stubReadyState(0);
    expect(database.isDatabaseConnected()).toBe(false);
  });
});
