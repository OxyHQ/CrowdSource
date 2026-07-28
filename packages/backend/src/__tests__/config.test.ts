import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `config` is a module-level singleton evaluated at import, which is the point:
 * a malformed deployment must fail at boot, not at the first request that
 * happens to read the bad value. Each case therefore re-imports the module with
 * a mutated environment.
 */
async function loadConfigModule(environment: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(environment)) {
    vi.stubEnv(key, value);
  }
  return import('../config');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config', () => {
  it('applies defaults when only NODE_ENV is set', async () => {
    const { config } = await loadConfigModule({ NODE_ENV: 'test' });

    expect(config.nodeEnv).toBe('test');
    expect(config.isProduction).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
  });

  it('reads a supplied port and log level', async () => {
    const { config } = await loadConfigModule({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'warn',
    });

    expect(config.isProduction).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('warn');
  });

  it('names the offending field when a value is malformed', async () => {
    await expect(loadConfigModule({ NODE_ENV: 'test', PORT: 'not-a-port' })).rejects.toThrow(
      /Invalid environment configuration.*PORT/s,
    );
  });

  it('treats a blank MONGODB_URI as absent rather than as an empty string', async () => {
    const { config } = await loadConfigModule({ NODE_ENV: 'test', MONGODB_URI: '   ' });

    expect(config.mongoUri).toBeUndefined();
  });

  it('rejects a connection pool whose minimum exceeds its maximum', async () => {
    await expect(
      loadConfigModule({
        NODE_ENV: 'test',
        MONGODB_MAX_POOL_SIZE: '5',
        MONGODB_MIN_POOL_SIZE: '10',
      }),
    ).rejects.toThrow(/MONGODB_MIN_POOL_SIZE must not exceed MONGODB_MAX_POOL_SIZE/);
  });

  it('reads Mongo tuning values', async () => {
    const { config } = await loadConfigModule({
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://localhost:27017/ignored',
      MONGODB_MAX_POOL_SIZE: '20',
      MONGODB_MAX_RETRIES: '2',
    });

    expect(config.mongoUri).toBe('mongodb://localhost:27017/ignored');
    expect(config.db.maxPoolSize).toBe(20);
    expect(config.db.maxRetries).toBe(2);
  });
});
