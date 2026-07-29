import { z } from 'zod';

/**
 * Runtime configuration, validated once at import time.
 *
 * Every value the process reads from the environment is declared here so a
 * malformed deployment fails at boot with a named field rather than at the
 * first request that happens to touch it.
 *
 * Nothing is declared here speculatively: a parameter no code reads is a secret
 * with no owner — it never rotates, and nothing fails when it goes stale. Add a
 * variable in the change that starts consuming it, not before.
 */

/** Treat a blank or whitespace-only variable as absent rather than as "". */
const optionalString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().optional());

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  /**
   * MongoDB connection string. The database COMPONENT of this URI is ignored:
   * the target is `databaseName(NODE_ENV)` from `./databaseIdentity`, which
   * Mongoose applies as `dbName` and which overrides whatever the URI names.
   */
  MONGODB_URI: optionalString,
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).default(50),
  MONGODB_MIN_POOL_SIZE: z.coerce.number().int().min(0).default(5),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(1).default(20_000),
  MONGODB_SOCKET_TIMEOUT_MS: z.coerce.number().int().min(1).default(45_000),
  MONGODB_MAX_RETRIES: z.coerce.number().int().min(1).default(5),
  /**
   * The key webhook signing secrets are encrypted with at rest (§13.4).
   *
   * 32 bytes, hex or base64. Deliberately OPTIONAL rather than required: a
   * newly-required variable refuses to boot the whole service the moment it
   * merges, for a module nothing calls yet. Absent, the two webhook-management
   * routes answer 503 naming this variable, so no endpoint can be registered
   * without a secret and no delivery can go out unsigned. See
   * `modules/webhooks/secretCipher.ts`.
   */
  WEBHOOK_SECRET_ENCRYPTION_KEY: optionalString,
});

function loadConfig() {
  const parsed = environmentSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }

  const environment = parsed.data;
  if (environment.MONGODB_MIN_POOL_SIZE > environment.MONGODB_MAX_POOL_SIZE) {
    throw new Error(
      'Invalid environment configuration — MONGODB_MIN_POOL_SIZE must not exceed MONGODB_MAX_POOL_SIZE.',
    );
  }

  return {
    nodeEnv: environment.NODE_ENV,
    isProduction: environment.NODE_ENV === 'production',
    port: environment.PORT,
    logLevel: environment.LOG_LEVEL,
    mongoUri: environment.MONGODB_URI,
    webhookSecretEncryptionKey: environment.WEBHOOK_SECRET_ENCRYPTION_KEY,
    db: {
      maxPoolSize: environment.MONGODB_MAX_POOL_SIZE,
      minPoolSize: environment.MONGODB_MIN_POOL_SIZE,
      serverSelectionTimeoutMS: environment.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      socketTimeoutMS: environment.MONGODB_SOCKET_TIMEOUT_MS,
      maxRetries: environment.MONGODB_MAX_RETRIES,
    },
  } as const;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export const config: AppConfig = loadConfig();
