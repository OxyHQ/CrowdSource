import { isIP } from 'node:net';

import { BLOCKED_HOSTNAMES, isBlockedIp } from '@oxyhq/core/server';
import {
  CreateReportRequestSchema,
  type CaseEnvelope,
  type CreateReportRequest,
} from '@oxyhq/crowdsource-contracts';
import { z } from 'zod';

import type { TenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';

/**
 * Ingress validation (§7.2), for the steps that belong to this service.
 *
 * §7.2 lists eight. Where each one actually lives:
 *
 *   1. Credential and scopes — `tenancy/serviceCredentialAuth.ts`.
 *   2. `schemaVersion` and JSON Schema — `CreateReportRequestSchema`, below.
 *   3. Size, resource count and MIME limits — the same schema; the contract
 *      declares the numbers as `CONTRACT_LIMITS` and enforces them in the parse,
 *      with `express.json`'s own limit catching a body too large to reach it.
 *   4. Hashes and completed uploads — PARTIAL, and honestly so. The contract
 *      requires a `sha256:<hex>` digest on every resource and on every asset,
 *      and rejects an asset that names both an upload and a URL. What cannot be
 *      checked is whether an `uploadId` refers to a finished upload, because
 *      CrowdSource has no upload path yet — see the evidence note in the phase
 *      report. Nothing here pretends otherwise.
 *   5. `externalReportId` idempotency — the unique indexes in
 *      `report.collection.ts`, not a check.
 *   6. Principal references and binding proofs — the envelope schema resolves
 *      every reference inside the envelope and requires a `bindingProofId` on an
 *      `oxy_user` binding. VERIFYING that proof is §11.14 and belongs to the
 *      reputation bridge; until it exists, a binding proves nothing beyond its
 *      own presence, and no Oxy Trust effect can be emitted from one (§15.8).
 *   7. Internal URLs, dangerous schemes, executable resources — the scheme is
 *      the contract's (`http`/`https` only); the host is `assertNoUnsafeUrls`
 *      below.
 *   8. Rate limits and tenant quotas — NOT implemented. A per-tenant quota needs
 *      a counter shared across tasks, which is the same single-node Valkey the
 *      queue decision turns on; a per-process limiter would silently divide the
 *      real limit by the number of running tasks.
 */

/**
 * The delivered envelope, once it is known to be one.
 *
 * `applicationId` is present and validated but is NEVER the source of tenancy —
 * see `assertEnvelopeBelongsToTenant`.
 */
export interface ValidatedDelivery {
  readonly externalReportId: string;
  readonly envelope: CaseEnvelope;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Parses a delivery against the published contract.
 *
 * A schema failure is 422 and not 400: the body IS valid JSON and the request
 * IS well-formed — what failed is the envelope, which §10.5 gives its own code
 * so an integrator can tell "I sent broken JSON" from "I sent an envelope this
 * service will not process". They call for different fixes.
 */
export function parseDelivery(body: unknown): ValidatedDelivery {
  const parsed = CreateReportRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'unprocessable_envelope',
      `The envelope cannot be processed — ${describeIssues(parsed.error)}`,
    );
  }

  const request: CreateReportRequest = parsed.data;
  return { externalReportId: request.externalReportId, envelope: request.envelope };
}

/**
 * Rejects an envelope that claims to belong to another application.
 *
 * The envelope carries `applicationId` and the contract says plainly what it is
 * for: so a mismatch can be DETECTED. The tenant still comes from the credential
 * and nothing here changes that — this check exists because an application
 * asserting somebody else's id is either a misconfigured integration writing
 * into the wrong tenant's stream, or an attempt at one, and both should stop at
 * the door rather than be silently rewritten to the caller's own id.
 *
 * 403 rather than 400: the request is well-formed and the caller is
 * authenticated; what it is not, is entitled to the tenant it named (§10.5).
 */
export function assertEnvelopeBelongsToTenant(
  context: TenantContext,
  envelope: CaseEnvelope,
): void {
  if (envelope.applicationId !== context.applicationId) {
    throw new ApiError(
      'forbidden',
      'The envelope names a different applicationId than the credential it was delivered with.',
    );
  }
}

/** Every URL an envelope can carry, with a path for the error message. */
function envelopeUrls(envelope: CaseEnvelope): { path: string; url: string }[] {
  const found: { path: string; url: string }[] = [];

  if (envelope.subject.permalink !== undefined) {
    found.push({ path: 'subject.permalink', url: envelope.subject.permalink });
  }

  envelope.resources.forEach((resource, index) => {
    if ('asset' in resource && resource.asset.url !== undefined) {
      found.push({ path: `resources.${index}.asset.url`, url: resource.asset.url });
    }
    if (resource.type === 'link') {
      found.push({ path: `resources.${index}.data.url`, url: resource.data.url });
    }
  });

  return found;
}

/**
 * Refuses a URL that points inside the network CrowdSource runs in (§7.2.7).
 *
 * This is the SYNTACTIC half of SSRF defence and it is deliberately not sold as
 * more than that. A literal address (`http://169.254.169.254/latest/…`,
 * `http://10.0.0.5/`) and a reserved name are decidable from the string alone,
 * so refusing them at ingress means a hostile URL never reaches storage and
 * never becomes evidence a reviewer might be handed.
 *
 * A hostname that RESOLVES to an internal address is not decidable here, and
 * pretending otherwise would be the more dangerous of the two mistakes — DNS can
 * change between this check and any later fetch, so the check that counts is the
 * one taken at fetch time with the connection pinned to the validated address.
 * That is `safeFetch` from `@oxyhq/core/server`, which is where every outbound
 * request must go. The primitives used here come from the same module, so there
 * is one denylist in the ecosystem rather than a second one drifting alongside it.
 */
export function assertNoUnsafeUrls(envelope: CaseEnvelope): void {
  for (const { path, url } of envelopeUrls(envelope)) {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // The contract already parsed it as a URL, so this is unreachable in
      // practice. Refusing rather than continuing keeps it that way.
      throw new ApiError('unprocessable_envelope', `${path} is not a usable URL.`);
    }

    // `URL` keeps IPv6 literals bracketed; the IP denylist wants the address.
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

    /**
     * `isBlockedIp` fails CLOSED: handed anything that is not an IP literal it
     * answers "blocked", which is right for its own caller — `safeFetch` only
     * ever passes it an address DNS already resolved — and wrong here, where the
     * input is a hostname most of the time. Gating on `isIP` is what keeps this
     * check to the question it can actually answer.
     */
    if (BLOCKED_HOSTNAMES.has(host) || (isIP(host) !== 0 && isBlockedIp(host))) {
      throw new ApiError(
        'unprocessable_envelope',
        `${path} points at a private, loopback or reserved address.`,
      );
    }
  }
}
