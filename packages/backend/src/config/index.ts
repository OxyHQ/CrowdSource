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
  /**
   * PostgreSQL connection string for the APPLICATION role, and the one
   * variable in this file that is required.
   *
   * Required rather than optional, unlike `WEBHOOK_SECRET_ENCRYPTION_KEY`
   * above, and the difference is what absence costs. An unset webhook key
   * degrades two routes to a 503 that names it. An unset database URL cannot
   * degrade anything: under `FORCE` row security every scoped read answers
   * ZERO ROWS rather than erroring, so a task with no database serves traffic
   * and reports perfect health while answering "you have no data" to every
   * customer. There is no production observation that separates that from a
   * quiet day — see `db/postgres/withTenant.ts` — so the only place it can be
   * caught is at boot, and the only way to catch it there is to refuse.
   *
   * The role this names owns NOTHING. It holds DML grants and is subject to
   * every policy; the migrator connects under its own separate credential,
   * which never reaches the serving container. See `MIGRATOR_DATABASE_URL` in
   * `scripts/migrate.ts`.
   */
  DATABASE_URL: z.string().min(1),
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

  /**
   * The Oxy API a reviewer session is verified against.
   *
   * No default, deliberately, and the app still boots without it: reviewer and
   * Trust & Safety routes are the only surface that needs it, and they answer
   * `503` while it is unset rather than silently accepting an unverified
   * session. The application API is unaffected — it authenticates service
   * credentials, which are CrowdSource's own.
   */
  OXY_API_URL: optionalString,

  /**
   * §8.2's personhood threshold for deciding a real case, in [0, 1].
   *
   * Configuration rather than a constant because the right value depends on how
   * many real reviewers exist, which changes. The default admits an unverified
   * account that completed training and passed calibration (0.6) and excludes a
   * bare authenticated account (0.3) — see `modules/reviewer/personhood.ts` for
   * the composition and for why a hard Oxy-verification gate was rejected.
   */
  REVIEWER_MIN_PERSONHOOD_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),

  /**
   * How many candidates one draw pulls from the eligibility index (§8.8).
   *
   * The cost of a draw is linear in this number and independent of how many
   * profiles exist, because the sample is a bounded range scan from a random
   * point on an indexed uniform key. Raising it buys a more representative pool
   * per draw; lowering it buys latency.
   */
  SORTITION_CANDIDATE_SAMPLE_SIZE: z.coerce.number().int().min(1).default(400),
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
    databaseUrl: environment.DATABASE_URL,
    webhookSecretEncryptionKey: environment.WEBHOOK_SECRET_ENCRYPTION_KEY,
    db: {
      maxPoolSize: environment.MONGODB_MAX_POOL_SIZE,
      minPoolSize: environment.MONGODB_MIN_POOL_SIZE,
      serverSelectionTimeoutMS: environment.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      socketTimeoutMS: environment.MONGODB_SOCKET_TIMEOUT_MS,
      maxRetries: environment.MONGODB_MAX_RETRIES,
    },
    oxy: {
      apiUrl: environment.OXY_API_URL,
    },
    reviewer: {
      minPersonhoodConfidence: environment.REVIEWER_MIN_PERSONHOOD_CONFIDENCE,
    },
    sortition: {
      candidateSampleSize: environment.SORTITION_CANDIDATE_SAMPLE_SIZE,
    },
  } as const;
}

export type AppConfig = ReturnType<typeof loadConfig>;

export const config: AppConfig = loadConfig();
