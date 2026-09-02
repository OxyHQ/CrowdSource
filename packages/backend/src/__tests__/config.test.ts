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

  it('reads DATABASE_URL', async () => {
    const { config } = await loadConfigModule({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://crowdsource_app:secret@db.internal/crowdsource',
    });

    expect(config.databaseUrl).toBe(
      'postgres://crowdsource_app:secret@db.internal/crowdsource',
    );
  });

  /**
   * The one required variable, and the reason it is required rather than
   * optional-with-a-503 like `WEBHOOK_SECRET_ENCRYPTION_KEY`.
   *
   * An absent database cannot degrade this service into something noticeable.
   * Under `FORCE` row security a scoped read with no working connection — or
   * with no tenant parameters set — returns ZERO ROWS rather than erroring, and
   * zero rows is what a customer with no cases legitimately sees. So a task with
   * no database serves traffic, passes every status-code check, and tells every
   * customer their data is gone. Production cannot contradict that: the database
   * being migrated to holds two documents. Boot is the only place it is
   * catchable, which is what this refusal buys.
   */
  it('refuses to boot without DATABASE_URL', async () => {
    await expect(
      loadConfigModule({ NODE_ENV: 'test', DATABASE_URL: '' }),
    ).rejects.toThrow(/Invalid environment configuration.*DATABASE_URL/s);
  });
});
