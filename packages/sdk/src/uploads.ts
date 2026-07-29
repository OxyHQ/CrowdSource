/**
 * Evidence uploads (§10.2 `POST /v1/uploads`, `POST /v1/uploads/{id}/complete`,
 * §12.10).
 *
 * **This surface has exactly one method and returns exactly one thing.** You
 * hand it bytes; it hands back the four fields an `AssetRef` needs. It never
 * returns a URL, and there is no way to ask it for one.
 *
 * That is §12.10 made structural rather than documented. Evidence is reached by
 * a temporary GET bound to a reviewer's assignment and written to an access log
 * — never by a durable link. A client method that returned the storage location
 * would put that link in an application's database within a week and in a
 * support email within a month, and no amount of "temporary" in a doc comment
 * would get it back. The presigned PUT this method uses is single-use,
 * write-only and short-lived; it lives inside one call and is never surfaced.
 *
 * The bytes are buffered, not streamed. Evidence is images, clips and documents
 * bounded by the tenant's own limits, and a streaming API would mean computing
 * the digest in a second pass over data the caller no longer has — the digest is
 * what makes the upload verifiable after the application deletes the original
 * (§5.6).
 *
 * **The backend does not serve either route yet.** Both answer 404 today, which
 * is the honest state: the evidence module has no HTTP surface. Nothing here
 * pretends otherwise, and nothing here falls back to embedding a URL in the
 * envelope instead.
 */

import type { AssetRef } from '@oxyhq/crowdsource-contracts';
import { z } from 'zod';

import { sha256Digest } from './digest';
import { CrowdSourceTransportError } from './errors';
import type { FetchLike, Transport } from './transport';

/**
 * A completed upload, in the shape an envelope's `asset` needs.
 *
 * Derived from the published `AssetRef` rather than restated, and `Required` so
 * `uploadId` is present: an asset reaching an envelope through this path is
 * always the upload branch of the contract's `uploadId` XOR `url` rule.
 */
export type EvidenceAsset = Required<Pick<AssetRef, 'uploadId' | 'mimeType' | 'sha256' | 'sizeBytes'>>;

const PresignedUploadSchema = z.looseObject({
  uploadId: z.string(),
  url: z.string(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const CompletedUploadSchema = z.looseObject({
  uploadId: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
  mimeType: z.string(),
});

export interface UploadInput {
  readonly bytes: Uint8Array;
  /** The media type CrowdSource will hold the bytes under, e.g. `image/jpeg`. */
  readonly mimeType: string;
  readonly signal?: AbortSignal;
}

export class Uploads {
  private readonly transport: Transport;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(input: { transport: Transport; fetch: FetchLike; timeoutMs: number }) {
    this.transport = input.transport;
    this.fetch = input.fetch;
    this.timeoutMs = input.timeoutMs;
  }

  /**
   * Requests a presigned PUT, sends the bytes, and finalises the upload with the
   * digest CrowdSource verifies against what actually arrived (§12.10).
   *
   * Idempotent by content: the request key is derived from the digest, so the
   * same bytes uploaded twice are one upload rather than two copies of the same
   * evidence sitting under a retention clock.
   */
  async upload(input: UploadInput): Promise<EvidenceAsset> {
    const sha256 = sha256Digest(input.bytes);
    const sizeBytes = input.bytes.byteLength;
    if (sizeBytes === 0) {
      throw new CrowdSourceTransportError('An evidence upload cannot be empty.', {
        retryable: false,
      });
    }

    const presigned = PresignedUploadSchema.safeParse(
      await this.transport.request<unknown>({
        method: 'POST',
        path: '/v1/uploads',
        body: { mimeType: input.mimeType, sizeBytes, sha256 },
        idempotencyKey: `upload.${sha256.replace('sha256:', '')}`,
        signal: input.signal,
      }),
    );
    if (!presigned.success) {
      throw new CrowdSourceTransportError(
        'CrowdSource answered the upload request with a body this client does not recognise.',
        { retryable: false, cause: presigned.error },
      );
    }

    await this.put(presigned.data, input);

    const completed = CompletedUploadSchema.safeParse(
      await this.transport.request<unknown>({
        method: 'POST',
        path: `/v1/uploads/${encodeURIComponent(presigned.data.uploadId)}/complete`,
        body: { sha256, sizeBytes, mimeType: input.mimeType },
        idempotencyKey: `upload.complete.${presigned.data.uploadId}`,
        signal: input.signal,
      }),
    );
    if (!completed.success) {
      throw new CrowdSourceTransportError(
        'CrowdSource answered the upload completion with a body this client does not recognise.',
        { retryable: false, cause: completed.error },
      );
    }

    /**
     * The digest is re-read from the completion response rather than reused from
     * the local computation. CrowdSource verifies the bytes it received; if the
     * two ever disagreed, the envelope must carry what CrowdSource holds, not
     * what this process believes it sent.
     */
    return {
      uploadId: completed.data.uploadId,
      mimeType: completed.data.mimeType,
      sha256: completed.data.sha256,
      sizeBytes: completed.data.sizeBytes,
    };
  }

  private async put(
    presigned: z.infer<typeof PresignedUploadSchema>,
    input: UploadInput,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal =
      input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);

    let response: Response;
    try {
      response = await this.fetch(presigned.url, {
        method: presigned.method ?? 'PUT',
        headers: { 'content-type': input.mimeType, ...presigned.headers },
        // `Uint8Array` is a valid BodyInit; the copy keeps the buffer from being
        // detached under a retry the caller may still perform.
        body: input.bytes.slice(),
        signal,
      });
    } catch (cause: unknown) {
      throw new CrowdSourceTransportError('The evidence upload did not complete.', { cause });
    }

    if (!response.ok) {
      throw new CrowdSourceTransportError(
        `Evidence storage refused the upload with ${response.status}.`,
        { retryable: response.status >= 500 },
      );
    }
  }
}
