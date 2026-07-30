import type { z } from 'zod';

import { ApiError } from './apiError';

/**
 * Parses a request body against a contract, or refuses with §10.5's `400`.
 *
 * Shared rather than restated per route because of the LAST line, not the first.
 * A Zod issue names the path it failed at and, for a reviewer submission, that
 * path runs through fields carrying case material — a reviewer's note, a
 * resource id, a policy rule. The message is composed from paths and Zod's own
 * wording and never from the submitted VALUES, and it is truncated, because an
 * error body is the one place a payload reliably escapes into a log somebody
 * later greps. Every route that parses a body has to get that right, so it is
 * written once.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid_request', message, {
      issues: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
        .slice(0, 500),
    });
  }
  return parsed.data;
}
