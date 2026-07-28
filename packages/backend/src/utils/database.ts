import mongoose from 'mongoose';

import { config } from '../config';
import { databaseName } from '../config/databaseIdentity';
import { logger } from './logger';

const INITIAL_RETRY_DELAY_MS = 1_000;

let connectPromise: Promise<typeof mongoose> | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeConnectionError(error: unknown): { code: string } {
  const code =
    error instanceof Error && 'code' in error && error.code
      ? String(error.code)
      : error instanceof Error && 'syscall' in error && error.syscall
        ? String(error.syscall)
        : '';
  return { code };
}

async function connectWithRetry(
  mongoUri: string,
  dbName: string,
  attempt: number,
  maxRetries: number,
): Promise<typeof mongoose> {
  try {
    await mongoose.connect(mongoUri, {
      // `dbName` overrides the database named in the URI. It comes from
      // `databaseIdentity`, never from configuration — see that file.
      dbName,
      autoIndex: !config.isProduction,
      autoCreate: !config.isProduction,
      serverSelectionTimeoutMS: config.db.serverSelectionTimeoutMS,
      socketTimeoutMS: config.db.socketTimeoutMS,
      maxPoolSize: config.db.maxPoolSize,
      minPoolSize: config.db.minPoolSize,
      // Idempotency here rests on unique indexes and retryable writes, so both
      // majority acknowledgement and retries are part of the contract, not
      // tuning knobs to relax under load.
      w: 'majority',
      retryWrites: true,
      retryReads: true,
    });

    logger.info({ dbName }, 'Connected to MongoDB');
    return mongoose;
  } catch (error: unknown) {
    const { code } = describeConnectionError(error);

    if (attempt < maxRetries) {
      const delay = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
      logger.warn(
        { code, attempt, maxRetries, delay },
        'MongoDB connection failed; retrying',
      );
      await wait(delay);
      return connectWithRetry(mongoUri, dbName, attempt + 1, maxRetries);
    }

    logger.error({ code, maxRetries }, 'Failed to connect to MongoDB');
    throw error;
  }
}

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }
  if (connectPromise) {
    return connectPromise;
  }

  const mongoUri = config.mongoUri;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not defined.');
  }

  const pendingConnection = connectWithRetry(
    mongoUri,
    databaseName(config.nodeEnv),
    1,
    config.db.maxRetries,
  );
  connectPromise = pendingConnection;

  try {
    return await pendingConnection;
  } finally {
    // A resolved promise must not mask a later disconnect. Concurrent callers
    // still share this attempt, while a later outage can start a fresh one.
    if (connectPromise === pendingConnection) {
      connectPromise = null;
    }
  }
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function disconnectFromDatabase(): Promise<void> {
  connectPromise = null;
  await mongoose.disconnect();
}
