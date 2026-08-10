import { and, arrayContains, desc, eq } from 'drizzle-orm';

import { webhookAttempts, webhookEndpoints, webhookSecrets } from '../../schema/webhooks';
import type { TenantScopedHandle } from '../../withTenant';

/**
 * The three tenant-owned webhook tables.
 *
 * `webhook_deliveries` is NOT here and is not an omission: the delivery worker
 * claims due rows across every tenant, so it is unscoped and takes a plain
 * `PgHandle`. Its `webhook_attempts` children ARE scoped, because the worker
 * derives a context from the delivery row it has just claimed. That seam — one
 * claim spanning tenants, everything below it scoped — is why the two live in
 * different directories.
 *
 * `TenantScopedHandle` first, no tenant predicate in any query — see
 * `scoped/cases.ts`.
 */

export interface NewWebhookEndpoint {
  readonly webhookEndpointId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly status: string;
}

export async function insertWebhookEndpoint(
  db: TenantScopedHandle,
  next: NewWebhookEndpoint,
): Promise<void> {
  await db.insert(webhookEndpoints).values({ ...next, eventTypes: [...next.eventTypes] });
}

export async function findWebhookEndpointById(db: TenantScopedHandle, webhookEndpointId: string) {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.webhookEndpointId, webhookEndpointId))
    .limit(1);

  return row ?? null;
}

/**
 * The fan-out read: active endpoints subscribed to an event type.
 *
 * `arrayContains` renders `@>`, which the GIN index on `event_types` serves. A
 * btree there would be an index the planner cannot use for containment — coverage
 * in name only, which reads as diligence while every fan-out sequential-scans. The
 * schema comment says the same thing; it is repeated here because this is the
 * query that would silently get slow.
 */
export async function listEndpointsForEvent(db: TenantScopedHandle, eventType: string) {
  return await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.status, 'active'),
        arrayContains(webhookEndpoints.eventTypes, [eventType]),
      ),
    );
}

export async function listWebhookEndpoints(db: TenantScopedHandle) {
  return await db.select().from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt));
}

/**
 * Disables an endpoint, and only one that is currently active.
 *
 * The `status = 'active'` predicate carries a real distinction: a 410 disables an
 * endpoint permanently and there is no re-enable route, so a second disable must
 * not overwrite the original `disabled_at` and reason with a later attempt's.
 */
export async function disableWebhookEndpoint(
  db: TenantScopedHandle,
  webhookEndpointId: string,
  reason: string,
  disabledAt: Date,
): Promise<number> {
  const rows = await db
    .update(webhookEndpoints)
    .set({ status: 'disabled', disabledReason: reason, disabledAt })
    .where(
      and(
        eq(webhookEndpoints.webhookEndpointId, webhookEndpointId),
        eq(webhookEndpoints.status, 'active'),
      ),
    )
    .returning({ webhookEndpointId: webhookEndpoints.webhookEndpointId });

  return rows.length;
}

export interface NewWebhookSecret {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly webhookEndpointId: string;
  readonly version: number;
  readonly algorithm: string;
  readonly keyFingerprint: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly activatesAt: Date;
  readonly expiresAt: Date | null;
}

export async function insertWebhookSecret(
  db: TenantScopedHandle,
  next: NewWebhookSecret,
): Promise<void> {
  await db.insert(webhookSecrets).values(next);
}

/**
 * The SIGNING read, which genuinely needs the envelope-encrypted material.
 *
 * Unlike `listCredentialSummaries` in the tenancy repository, the secret columns
 * cannot be projected away here — the signer needs them. So the protection is
 * different in kind: this function exists to be called by the signer and by
 * nothing else, and `ciphertext`, `iv`, `auth_tag` and `key_fingerprint` must
 * never be logged or returned on a public surface.
 *
 * Ordered by `activates_at` descending so the current secret leads and the
 * rotation overlap follows, which is the order the signer wants to try them in.
 */
export async function listWebhookSecretsForSigning(
  db: TenantScopedHandle,
  webhookEndpointId: string,
) {
  return await db
    .select()
    .from(webhookSecrets)
    .where(eq(webhookSecrets.webhookEndpointId, webhookEndpointId))
    .orderBy(desc(webhookSecrets.activatesAt));
}

/**
 * Endpoint secret METADATA — no key material.
 *
 * The select list names its columns and the four secret-bearing ones are absent,
 * so a console serializer that reaches for them fails `tsc`. This is the read any
 * operator surface should use; the signing read above is not.
 */
export interface WebhookSecretSummaryRow {
  readonly webhookEndpointId: string;
  readonly version: number;
  readonly algorithm: string;
  readonly activatesAt: Date;
  readonly expiresAt: Date | null;
}

export async function listWebhookSecretSummaries(
  db: TenantScopedHandle,
  webhookEndpointId: string,
): Promise<WebhookSecretSummaryRow[]> {
  return await db
    .select({
      webhookEndpointId: webhookSecrets.webhookEndpointId,
      version: webhookSecrets.version,
      algorithm: webhookSecrets.algorithm,
      activatesAt: webhookSecrets.activatesAt,
      expiresAt: webhookSecrets.expiresAt,
    })
    .from(webhookSecrets)
    .where(eq(webhookSecrets.webhookEndpointId, webhookEndpointId))
    .orderBy(desc(webhookSecrets.activatesAt));
}

export interface NewWebhookAttempt {
  readonly attemptId: string;
  readonly organizationId: string;
  readonly applicationId: string;
  readonly deliveryId: string;
  readonly webhookEndpointId: string;
  readonly eventId: string;
  readonly attemptNumber: number;
  readonly outcome: string;
  readonly responseStatus: number | null;
  readonly failureKind: string | null;
  readonly latencyMs: number;
  readonly responseBodyPreview: string;
  readonly nextAttemptAt: Date | null;
  readonly secretVersion: number | null;
  readonly attemptedAt: Date;
}

/**
 * Appends one attempt.
 *
 * `response_body_preview` is REQUIRED and takes the empty string for a success
 * rather than being optional: the empty string is the correct stored value, and a
 * null would make "succeeded, no body" indistinguishable from "we failed to record
 * one". The schema states this; the parameter type is what enforces it on callers.
 */
export async function appendWebhookAttempt(
  db: TenantScopedHandle,
  attempt: NewWebhookAttempt,
): Promise<void> {
  await db.insert(webhookAttempts).values(attempt);
}

/** One delivery's attempts, in the order they were made. */
export async function listWebhookAttempts(db: TenantScopedHandle, deliveryId: string) {
  return await db
    .select()
    .from(webhookAttempts)
    .where(eq(webhookAttempts.deliveryId, deliveryId))
    .orderBy(webhookAttempts.attemptNumber);
}
