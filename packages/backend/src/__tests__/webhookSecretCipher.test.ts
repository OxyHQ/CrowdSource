import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { config } from '../config';
import { ApiError } from '../http/apiError';
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  WebhookSecretUnavailableError,
  webhookSecretStorageConfigured,
} from '../modules/webhooks/secretCipher';

/**
 * Encryption at rest for webhook signing secrets (§13.4).
 *
 * §13.4 says KMS; CrowdSource has none, so the closest honest analogue is a
 * deployment-held key and AES-256-GCM. These tests are about the three ways
 * that goes wrong in practice: the key is missing, the key is the wrong one, or
 * the stored bytes were altered. Each has to fail by NAME — a decryption error
 * that reads like corruption sends an operator looking for a restore when what
 * they need is a rotation.
 */

/** Replaces the configured key for one test, without touching the environment. */
function withKey(value: string | undefined): void {
  vi.spyOn(config, 'webhookSecretEncryptionKey', 'get').mockReturnValue(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a generated secret', () => {
  it('is 32 bytes of CSPRNG output, urlsafe', () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
  });

  it('is different every time', () => {
    const drawn = new Set(Array.from({ length: 50 }, () => generateWebhookSecret()));
    expect(drawn.size).toBe(50);
  });
});

describe('a round trip', () => {
  it('returns exactly what was stored', () => {
    const secret = generateWebhookSecret();
    expect(decryptWebhookSecret(encryptWebhookSecret(secret))).toBe(secret);
  });

  it('never writes the secret down in the clear', () => {
    const secret = generateWebhookSecret();
    const stored = encryptWebhookSecret(secret);

    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored.ciphertext).not.toContain(secret);
  });

  it('uses a fresh IV each time, so two identical secrets do not look identical', () => {
    const secret = generateWebhookSecret();
    const first = encryptWebhookSecret(secret);
    const second = encryptWebhookSecret(secret);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('accepts a hex key and a base64 key alike', () => {
    const raw = randomBytes(32);
    const secret = generateWebhookSecret();

    for (const encoded of [raw.toString('hex'), raw.toString('base64')]) {
      withKey(encoded);
      expect(decryptWebhookSecret(encryptWebhookSecret(secret))).toBe(secret);
      vi.restoreAllMocks();
    }
  });
});

describe('a missing key', () => {
  it('is a 503 about configuration, naming the variable', () => {
    withKey(undefined);

    expect(webhookSecretStorageConfigured()).toBe(false);
    try {
      encryptWebhookSecret('anything');
      expect.unreachable('encryption must refuse without a key');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(503);
      expect((error as ApiError).message).toContain('WEBHOOK_SECRET_ENCRYPTION_KEY');
    }
  });

  it('makes a stored secret unavailable rather than silently unsigned', () => {
    const stored = encryptWebhookSecret(generateWebhookSecret());
    withKey(undefined);

    expect(() => decryptWebhookSecret(stored)).toThrow(WebhookSecretUnavailableError);
  });
});

describe('a key of the wrong size', () => {
  it('is refused rather than silently downgrading AES-256', () => {
    withKey(Buffer.from('too short').toString('base64'));

    expect(webhookSecretStorageConfigured()).toBe(false);
    expect(() => encryptWebhookSecret('anything')).toThrow(/32 bytes/);
  });
});

describe('a secret encrypted under a different key', () => {
  /**
   * GCM fails identically for a wrong key and for altered bytes, so the
   * fingerprint is what separates them. Without it an operator who rotated the
   * deployment key would see what looks like data corruption.
   */
  it('says so, instead of failing as corruption', () => {
    const stored = encryptWebhookSecret(generateWebhookSecret());
    withKey(randomBytes(32).toString('hex'));

    expect(() => decryptWebhookSecret(stored)).toThrow(/different WEBHOOK_SECRET_ENCRYPTION_KEY/);
  });
});

describe('altered stored bytes', () => {
  it('fail authentication and say the stored form was altered', () => {
    const stored = encryptWebhookSecret(generateWebhookSecret());
    const tampered = {
      ...stored,
      ciphertext: Buffer.from(
        Buffer.from(stored.ciphertext, 'base64').map((byte, index) =>
          index === 0 ? byte ^ 0xff : byte,
        ),
      ).toString('base64'),
    };

    expect(() => decryptWebhookSecret(tampered)).toThrow(/altered/);
  });

  it('reject a swapped auth tag, so the ciphertext cannot be reused with another', () => {
    const first = encryptWebhookSecret(generateWebhookSecret());
    const second = encryptWebhookSecret(generateWebhookSecret());

    expect(() => decryptWebhookSecret({ ...first, authTag: second.authTag })).toThrow(/altered/);
  });

  it('refuse an algorithm this build does not implement', () => {
    const stored = encryptWebhookSecret(generateWebhookSecret());

    expect(() => decryptWebhookSecret({ ...stored, algorithm: 'aes-128-cbc' })).toThrow(
      /cannot read/,
    );
  });
});

describe('what a failure says', () => {
  /**
   * §13.4's log-redaction rule applied to error text. A cipher error can quote
   * the buffer it choked on, and that buffer is a signing secret.
   */
  it('never quotes the secret or the ciphertext', () => {
    const secret = generateWebhookSecret();
    const stored = encryptWebhookSecret(secret);
    withKey(randomBytes(32).toString('hex'));

    try {
      decryptWebhookSecret(stored);
      expect.unreachable('decryption must refuse under the wrong key');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(stored.ciphertext);
    }
  });
});
