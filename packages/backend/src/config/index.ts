import { z } from 'zod';

/** Treat a blank or whitespace-only variable as absent. */
const optionalString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().optional());

/** PostgreSQL-only runtime configuration, validated once at import time. */
/** What the nightly reconciliation of Oxy file references does (`docs/architecture/evidence-files.md`). */
export const OXY_FILE_RECONCILIATION_MODES = ['apply', 'dry_run', 'off'] as const;

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Required application-role connection; migrations use MIGRATOR_DATABASE_URL separately. */
  DATABASE_URL: z.string().min(1),
  WEBHOOK_SECRET_ENCRYPTION_KEY: optionalString,
  OXY_API_URL: optionalString,
  /**
   * The signing secret Oxy returned when this service's file-events endpoint
   * was set (oxy ADR 0043 D9; `docs/architecture/evidence-files.md`). Optional
   * so the endpoint can answer Oxy's verification challenge before it exists;
   * without it every signed event answers 503 and Oxy retries.
   */
  OXY_FILES_WEBHOOK_SECRET: optionalString,
  /**
   * The nightly reconciliation of this service's Oxy file references: `apply`
   * (the default — what keeps Oxy's record of evidence in use exact),
   * `dry_run` (counts only, nothing changes) or `off`.
   */
  OXY_FILE_RECONCILIATION: z.enum(OXY_FILE_RECONCILIATION_MODES).default('apply'),
  REVIEWER_MIN_PERSONHOOD_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
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
  return {
    nodeEnv: environment.NODE_ENV,
    isProduction: environment.NODE_ENV === 'production',
    port: environment.PORT,
    logLevel: environment.LOG_LEVEL,
    databaseUrl: environment.DATABASE_URL,
    webhookSecretEncryptionKey: environment.WEBHOOK_SECRET_ENCRYPTION_KEY,
    oxy: {
      apiUrl: environment.OXY_API_URL,
      filesWebhookSecret: environment.OXY_FILES_WEBHOOK_SECRET,
      fileReconciliation: environment.OXY_FILE_RECONCILIATION,
    },
    reviewer: { minPersonhoodConfidence: environment.REVIEWER_MIN_PERSONHOOD_CONFIDENCE },
    sortition: { candidateSampleSize: environment.SORTITION_CANDIDATE_SAMPLE_SIZE },
  } as const;
}

export type AppConfig = ReturnType<typeof loadConfig>;
export const config: AppConfig = loadConfig();
