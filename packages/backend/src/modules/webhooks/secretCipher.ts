import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { config } from '../../config';
import { ApiError } from '../../http/apiError';

/**
 * Encryption at rest for webhook signing secrets (§13.4).
 *
 * §13.4 asks for KMS. CrowdSource has none — the same divergence that put
 * evidence on `cloud.oxy.so` instead of S3 — so the closest honest analogue is a
 * deployment-held key and AES-256-GCM. What that buys is the actual threat §13.4
 * is about: a database dump on its own cannot forge a signature to a tenant's
 * receiver, because the key is not in the database.
 *
 * A webhook secret cannot be hashed the way a service credential is. We have to
 * REPRODUCE it to sign every delivery, so it is reversible by design, and the
 * question is only who holds the key.
 *
 * ## Why the key is not required at boot
 *
 * Declaring it required would mean the next deploy of a service that does not yet
 * have the secret refuses to start — the whole backend down for a module nothing
 * calls yet. Instead the key is optional, and the two places that need it refuse
 * clearly: registration and rotation answer 503 with the variable named, and a
 * delivery whose secret cannot be decrypted records a `secret_unavailable`
 * attempt and retries. No endpoint can exist without a secret, so there is no
 * path where a missing key produces an UNSIGNED delivery.
 *
 * ## Why the fingerprint
 *
 * GCM authentication fails identically for a corrupted ciphertext and for the
 * wrong key. Storing a fingerprint of the key that encrypted each secret turns
 * the second case into a named error an operator can act on — "this was
 * encrypted under a different key" — instead of a decryption failure that reads
 * like data loss.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits, the size GCM is specified for. */
const IV_BYTES = 12;

/** The stored form of a secret. Everything except the key. */
export interface EncryptedSecret {
  readonly algorithm: string;
  readonly keyFingerprint: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

/**
 * Thrown when a stored secret cannot be turned back into a signing key.
 *
 * Distinct from `ApiError` on purpose: this reaches the delivery worker, not an
 * HTTP response, and the worker classifies it rather than answering with it.
 */
export class WebhookSecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSecretUnavailableError';
  }
}

/**
 * The configured key.
 *
 * Accepts base64 or hex and insists on 32 bytes, because a shorter value
 * silently downgrades AES-256 to whatever was pasted. Read on every call rather
 * than cached at import: `config` is validated once, but a test that needs to
 * exercise the unconfigured path must be able to reach it.
 */
function encryptionKey(): Buffer {
  const configured = config.webhookSecretEncryptionKey;
  if (!configured) {
    throw new ApiError(
      'service_unavailable',
      'Webhook secret storage is not configured: WEBHOOK_SECRET_ENCRYPTION_KEY is unset.',
    );
  }

  const decoded = decodeKey(configured);
  if (decoded.length !== KEY_BYTES) {
    throw new ApiError(
      'service_unavailable',
      `WEBHOOK_SECRET_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; it decoded to ${decoded.length}.`,
    );
  }
  return decoded;
}

/** Base64 or hex, decided by shape rather than by a second variable to keep in step. */
function decodeKey(configured: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    return Buffer.from(configured, 'hex');
  }
  return Buffer.from(configured, 'base64');
}

/** True when a secret can be stored at all. Read by the routes before they act. */
export function webhookSecretStorageConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    // The reason is the caller's to raise; this predicate answers only whether
    // the module can work. It is not a swallowed failure: every path that needs
    // the key calls `encryptionKey` again and throws with the reason attached.
    return false;
  }
}

/**
 * A fingerprint of the key, not the key.
 *
 * Truncated to 16 hex characters. It identifies which key was used and reveals
 * nothing usable about it — a full digest of a 32-byte secret is still a target
 * for an offline search, and 64 bits of identifier is more than enough to tell
 * two deployment keys apart.
 */
function fingerprintOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** A fresh signing secret: 32 bytes, base64url, no padding. */
export function generateWebhookSecret(): string {
  return randomBytes(KEY_BYTES).toString('base64url');
}

export function encryptWebhookSecret(secret: string): EncryptedSecret {
  const key = encryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

  return {
    algorithm: ALGORITHM,
    keyFingerprint: fingerprintOf(key),
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptWebhookSecret(stored: EncryptedSecret): string {
  let key: Buffer;
  try {
    key = encryptionKey();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'The encryption key is unusable.';
    throw new WebhookSecretUnavailableError(reason);
  }

  if (stored.algorithm !== ALGORITHM) {
    throw new WebhookSecretUnavailableError(
      `This secret was stored with '${stored.algorithm}', which this build cannot read.`,
    );
  }
  if (stored.keyFingerprint !== fingerprintOf(key)) {
    // Named, rather than left to surface as a GCM authentication failure that
    // looks like corruption. The recovery is a rotation, not a restore.
    throw new WebhookSecretUnavailableError(
      'This secret was encrypted under a different WEBHOOK_SECRET_ENCRYPTION_KEY.',
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(stored.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(stored.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(stored.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    /**
     * Authentication failed with the right key, which means the stored bytes
     * were altered. The underlying error text is discarded rather than wrapped:
     * a cipher error can quote the buffer it choked on, and that buffer is a
     * signing secret.
     */
    throw new WebhookSecretUnavailableError(
      'This secret failed authenticated decryption; its stored form has been altered.',
    );
  }
}
