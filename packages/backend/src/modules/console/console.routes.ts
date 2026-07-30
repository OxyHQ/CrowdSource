import { Router } from 'express';
import { z } from 'zod';

import { createTenantContext } from '../../db/tenantScope';
import { ApiError } from '../../http/apiError';
import { isPublicId } from '../../utils/identifiers';
import { appendAuditEvent } from '../audit/audit.collection';
import { APPLICATION_SCOPES } from '../tenancy/scopes';
import {
  createApplication,
  createOrganization,
  issueApplicationCredential,
  listApplicationCredentials,
  revokeCredential,
} from '../tenancy/provisioning.service';
import { applications } from '../tenancy/tenancy.collections';
import { applicationTrustFor, quotaForApplication } from '../trust/applicationTrust.service';
import {
  findTenantDelivery,
  listTenantDeliveries,
  replayDeadLetteredDelivery,
} from '../webhooks/delivery.service';
import { rotateWebhookSecret, MAX_SECRET_OVERLAP_SECONDS } from '../webhooks/endpoint.service';
import { webhookSecretStorageConfigured } from '../webhooks/secretCipher';
import type { WebhookDeliveryDocument } from '../webhooks/webhook.collections';
import { findCaseDetail, listCases } from './caseExplorer.service';
import { CASE_STATUSES } from '../cases/case.collection';
import { CONSOLE_ROLES, type OrganizationMemberDocument } from './console.collections';
import { consoleUser, requireConsoleSession, staffRolesOf } from './consoleAuth';
import {
  grantMembership,
  membersOf,
  membershipsWithOrganizations,
  requireMembership,
  requireRole,
  resolveApplicationForMember,
  revokeMembership,
} from './membership.service';
import {
  auditTrail,
  DEFAULT_USAGE_WINDOW_DAYS,
  endpointsWithHealth,
  MAX_USAGE_WINDOW_DAYS,
  usageSummary,
} from './operations.service';

/**
 * The developer console API (§4.2, §15.10's "Developer Console autoservicio").
 *
 * Every route here is an OXY SESSION caller, and a service credential satisfies none
 * of them — it presents a token the shared SDK does not recognise as a session, so it
 * never reaches a handler. That is the structural half of the separation §10.1
 * requires; the other half is that no route below reads a tenant from the request.
 *
 * **How the tenant is established, in one sentence:** the path names an application
 * id, `resolveApplicationForMember` reads that application, takes `organizationId`
 * from the STORED row, requires an active membership for the authenticated Oxy user,
 * and only then constructs the context. A caller therefore chooses which of its own
 * tenants to look at, and the database decides which are its own. No handler here
 * reads an `organizationId` from a body or a query string — there is no such code
 * path to find.
 *
 * Roles: reading needs `viewer`, and anything that changes production behaviour —
 * issuing or revoking a credential, rotating a secret, replaying a delivery, adding a
 * member, creating an application — needs `admin`. `developer` sits between them for
 * the surfaces that will grow write operations of their own (custom schemas, policy
 * sets) and holds no write capability yet, which is deliberately visible in the code
 * rather than implied by its absence.
 */

export const consoleRouter: Router = Router();

const CreateOrganizationSchema = z.strictObject({
  name: z.string().min(1).max(200),
  slug: z.string().min(2).max(63),
});

const CreateApplicationSchema = z.strictObject({
  name: z.string().min(1).max(200),
});

const GrantMemberSchema = z.strictObject({
  /**
   * An Oxy user id, taken as an opaque string.
   *
   * Deliberately NOT validated against Oxy's id format, and not resolved against Oxy
   * either. Inventing a shape here would be a second definition of what an Oxy user
   * id looks like — the mistake `oxySession.ts` exists to prevent — and a membership
   * for an account that does not exist is harmless: nobody can ever authenticate as
   * it. What would be harmful is a console that could enumerate Oxy accounts by
   * probing which ones an invitation accepts.
   */
  oxyUserId: z.string().min(1).max(200),
  role: z.enum(CONSOLE_ROLES),
});

const IssueCredentialSchema = z.strictObject({
  scopes: z.array(z.enum(APPLICATION_SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

const RotateSecretSchema = z.strictObject({
  overlapSeconds: z.number().int().min(0).max(MAX_SECRET_OVERLAP_SECONDS).optional(),
});

function memberView(member: OrganizationMemberDocument): Record<string, unknown> {
  return {
    oxyUserId: member.oxyUserId,
    role: member.role,
    status: member.status,
    invitedByOxyUserId: member.invitedByOxyUserId,
    createdAt: member.createdAt.toISOString(),
  };
}

/**
 * A delivery as the console shows it.
 *
 * `body` is absent, and that is the field worth naming: it holds the exact signed
 * bytes of the event. The console has no use for them — an integrator debugging a
 * delivery needs the status, the attempt count and the reason it stopped — and
 * serving them would make the console a reader of event payloads for every tenant
 * whose deliveries an operator can list.
 */
function deliveryView(delivery: WebhookDeliveryDocument): Record<string, unknown> {
  return {
    deliveryId: delivery.deliveryId,
    webhookEndpointId: delivery.webhookEndpointId,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    cycleAttemptCount: delivery.cycleAttemptCount,
    lastResponseStatus: delivery.lastResponseStatus,
    deadLetterReason: delivery.deadLetterReason,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? null,
    succeededAt: delivery.succeededAt?.toISOString() ?? null,
    deadLetteredAt: delivery.deadLetteredAt?.toISOString() ?? null,
    replayCount: delivery.replayCount,
    createdAt: delivery.createdAt.toISOString(),
    updatedAt: delivery.updatedAt.toISOString(),
  };
}

/** The application id from the path, or a 404 before any query is spent. */
function pathApplicationId(raw: unknown): string {
  if (typeof raw !== 'string' || !isPublicId('application', raw)) {
    throw new ApiError('not_found', 'No such application.');
  }
  return raw;
}

function pathOrganizationId(raw: unknown): string {
  if (typeof raw !== 'string' || !isPublicId('organization', raw)) {
    throw new ApiError('not_found', 'No such organization.');
  }
  return raw;
}

/**
 * `GET /v1/console/session` — who this session is, and what it can reach.
 *
 * One request the console makes at boot instead of N: the memberships decide which
 * organizations to render and the staff roles decide whether the Trust & Safety
 * navigation exists at all. The roles here are a COURTESY for the interface and never
 * the boundary — every Trust & Safety route checks its own role, so a client that
 * ignored this list and called anyway is refused by the route.
 */
consoleRouter.get('/console/session', ...requireConsoleSession(), async (request, response) => {
  const oxyUserId = consoleUser(request);
  const [memberships, staffRoles] = await Promise.all([
    membershipsWithOrganizations(oxyUserId),
    staffRolesOf(oxyUserId),
  ]);

  response.status(200).json({
    oxyUserId,
    memberships: memberships.map((membership) => ({
      organizationId: membership.organizationId,
      name: membership.name,
      slug: membership.slug,
      status: membership.status,
      role: membership.role,
    })),
    staffRoles,
  });
});

/**
 * `GET /v1/console/organizations` — the organizations this session belongs to.
 *
 * There is no "list all organizations" anywhere in this router, and there will not be:
 * a developer surface that could enumerate tenants is a customer list.
 */
consoleRouter.get(
  '/console/organizations',
  ...requireConsoleSession(),
  async (request, response) => {
    const memberships = await membershipsWithOrganizations(consoleUser(request));

    const rows: Record<string, unknown>[] = [];
    for (const membership of memberships) {
      rows.push({
        organizationId: membership.organizationId,
        name: membership.name,
        slug: membership.slug,
        status: membership.status,
        role: membership.role,
        applicationCount: await applications.countDocuments({
          organizationId: membership.organizationId,
        }),
      });
    }

    response.status(200).json({ organizations: rows });
  },
);

/**
 * `POST /v1/console/organizations` — self-service tenant creation (§15.10).
 *
 * The creator becomes the `owner`, in the same request. An organization created
 * without one would be unreachable through every other route in this file, because
 * they all begin with a membership check — so the seat is not a convenience, it is
 * what makes the organization exist as far as the console is concerned.
 */
consoleRouter.post(
  '/console/organizations',
  ...requireConsoleSession(),
  async (request, response) => {
    const oxyUserId = consoleUser(request);
    const parsed = CreateOrganizationSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('invalid_request', 'An organization needs a name and a slug.');
    }

    const organization = await createOrganization({
      name: parsed.data.name,
      slug: parsed.data.slug,
    });
    await grantMembership({
      organizationId: organization.organizationId,
      oxyUserId,
      role: 'owner',
      invitedByOxyUserId: oxyUserId,
    });

    response.status(201).json({
      organizationId: organization.organizationId,
      name: organization.name,
      slug: organization.slug,
      role: 'owner',
    });
  },
);

consoleRouter.get(
  '/console/organizations/:organizationId/members',
  ...requireConsoleSession(),
  async (request, response) => {
    const organizationId = pathOrganizationId(request.params.organizationId);
    await requireMembership(consoleUser(request), organizationId);

    const members = await membersOf(organizationId);
    response.status(200).json({ members: members.map(memberView) });
  },
);

consoleRouter.post(
  '/console/organizations/:organizationId/members',
  ...requireConsoleSession(),
  async (request, response) => {
    const oxyUserId = consoleUser(request);
    const organizationId = pathOrganizationId(request.params.organizationId);
    requireRole(await requireMembership(oxyUserId, organizationId), 'admin');

    const parsed = GrantMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'invalid_request',
        `A membership needs an oxyUserId and one of the roles: ${CONSOLE_ROLES.join(', ')}.`,
      );
    }

    const member = await grantMembership({
      organizationId,
      oxyUserId: parsed.data.oxyUserId,
      role: parsed.data.role,
      invitedByOxyUserId: oxyUserId,
    });
    /**
     * No audit row for a seat change, and it is a gap rather than a decision I am happy
     * with. `audit_events` is APPLICATION-scoped and a seat is ORGANIZATION-scoped, so
     * recording one would mean inventing an application for it to belong to. What exists
     * instead is on the membership row itself — `invitedByOxyUserId`, `status`,
     * `revokedAt` — which answers "who let them in" but is not append-only: a re-grant
     * overwrites the previous inviter. An organization-scoped audit collection is the
     * real fix.
     */
    response.status(201).json(memberView(member));
  },
);

consoleRouter.post(
  '/console/organizations/:organizationId/members/:memberOxyUserId/revoke',
  ...requireConsoleSession(),
  async (request, response) => {
    const organizationId = pathOrganizationId(request.params.organizationId);
    requireRole(await requireMembership(consoleUser(request), organizationId), 'admin');

    /**
     * No SHAPE check on the member id, unlike every other path parameter here: an Oxy
     * user id is an opaque string and this router deliberately does not define what one
     * looks like (see `GrantMemberSchema`). `revokeMembership` answers 404 for anything
     * that is not an active seat, which covers every value a caller can send.
     *
     * `String()` rather than a type guard because Express 5 types every path parameter as
     * `string | string[]` — the array arm exists for wildcard patterns, and this route has
     * none, so a guard for it would be a branch no request can take. Coercing keeps the
     * type honest without adding an unreachable path: a value that somehow arrived as an
     * array collapses to something no seat matches, which is the 404 above.
     */
    const memberOxyUserId = String(request.params.memberOxyUserId);
    await revokeMembership(organizationId, memberOxyUserId);
    response.status(200).json({ oxyUserId: memberOxyUserId, status: 'revoked' });
  },
);

consoleRouter.get(
  '/console/organizations/:organizationId/applications',
  ...requireConsoleSession(),
  async (request, response) => {
    const organizationId = pathOrganizationId(request.params.organizationId);
    await requireMembership(consoleUser(request), organizationId);

    const rows = await applications.find(
      { organizationId },
      { sort: { createdAt: -1 }, limit: 200 },
    );

    const withStanding: Record<string, unknown>[] = [];
    for (const application of rows) {
      const trust = await applicationTrustFor({
        organizationId,
        applicationId: application.applicationId,
      });
      withStanding.push({
        applicationId: application.applicationId,
        name: application.name,
        status: application.status,
        standing: trust.standing,
        globalReputationEffectsAllowed: trust.globalReputationEffectsAllowed,
        createdAt: application.createdAt.toISOString(),
      });
    }

    response.status(200).json({ applications: withStanding });
  },
);

consoleRouter.post(
  '/console/organizations/:organizationId/applications',
  ...requireConsoleSession(),
  async (request, response) => {
    const organizationId = pathOrganizationId(request.params.organizationId);
    requireRole(await requireMembership(consoleUser(request), organizationId), 'admin');

    const parsed = CreateApplicationSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('invalid_request', 'An application needs a name.');
    }

    const application = await createApplication({ organizationId, name: parsed.data.name });
    await appendAuditEvent(
      /**
       * Both ids off the RESULT, not the path — even though `requireMembership` above
       * already proved this caller's seat in the path's organization, and
       * `createApplication` read the organization row before creating anything.
       *
       * The rule is worth keeping mechanical rather than case-by-case: a tenant key that
       * came from a request is one an auditor has to trace back through the handler to
       * clear, and the next person to copy this block may not carry the membership check
       * with it. `createApplication` returns the organization it actually wrote under.
       */
      createTenantContext(application.organizationId, application.applicationId),
      {
        action: 'console.application.created',
        actorOxyUserId: consoleUser(request),
        subjectId: application.applicationId,
      },
    );

    response.status(201).json({
      applicationId: application.applicationId,
      name: application.name,
      status: 'active',
      // Every new application starts here (§11.13). The console says so explicitly
      // rather than leaving an integrator to discover it from a 403 later.
      standing: 'sandbox',
    });
  },
);

consoleRouter.get(
  '/console/applications/:applicationId',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant, role, application } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );
    const [trust, quota] = await Promise.all([
      applicationTrustFor(tenant),
      quotaForApplication(tenant),
    ]);

    response.status(200).json({
      applicationId: application.applicationId,
      organizationId: application.organizationId,
      name: application.name,
      status: application.status,
      createdAt: application.createdAt.toISOString(),
      role,
      trust: {
        standing: trust.standing,
        globalReputationEffectsAllowed: trust.globalReputationEffectsAllowed,
        /**
         * `null` where nothing measures the signal yet — see the collection for why
         * these are not zeros. The console renders an absent value as absent rather
         * than as a bad score.
         */
        evidenceIntegrity: trust.evidenceIntegrity,
        identityBindingReliability: trust.identityBindingReliability,
        policyQuality: trust.policyQuality,
        lastStandingReason: trust.lastStandingReason,
        standingChangedAt: trust.standingChangedAt?.toISOString() ?? null,
        updatedAt: trust.updatedAt.toISOString(),
      },
      quota,
    });
  },
);

consoleRouter.get(
  '/console/applications/:applicationId/credentials',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );

    const credentials = await listApplicationCredentials(
      tenant.organizationId,
      tenant.applicationId,
    );

    response.status(200).json({
      credentials: credentials.map((credential) => ({
        credentialId: credential.credentialId,
        scopes: credential.scopes,
        status: credential.status,
        expiresAt: credential.expiresAt?.toISOString() ?? null,
        revokedAt: credential.revokedAt?.toISOString() ?? null,
        createdAt: credential.createdAt.toISOString(),
      })),
    });
  },
);

consoleRouter.post(
  '/console/applications/:applicationId/credentials',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant, role } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );
    requireRole(role, 'admin');

    const parsed = IssueCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'invalid_request',
        `A credential needs at least one of the scopes: ${APPLICATION_SCOPES.join(', ')}.`,
      );
    }

    /**
     * Privileged scopes cannot be requested here at all — the schema's enum is
     * `APPLICATION_SCOPES`, so `reputation:moderation:apply` fails validation before
     * `issueApplicationCredential` even sees it. That function refuses them too,
     * which is the point: §13.2's "los scopes privilegiados no son self grantable"
     * holds at the transport AND in the domain, so neither one being wrong is enough.
     */
    const issued = await issueApplicationCredential({
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      scopes: parsed.data.scopes,
      ...(parsed.data.expiresInDays === undefined
        ? {}
        : {
            expiresAt: new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000),
          }),
    });

    await appendAuditEvent(tenant, {
      action: 'console.credential.issued',
      actorOxyUserId: consoleUser(request),
      subjectId: issued.credentialId,
    });

    // The token appears in this response and nowhere else, ever (§13.4). Only its
    // SHA-256 is stored, so nothing — including this service — can recover it later.
    response.status(201).json({
      credentialId: issued.credentialId,
      scopes: issued.scopes,
      token: issued.token,
      createdAt: new Date().toISOString(),
    });
  },
);

consoleRouter.post(
  '/console/applications/:applicationId/credentials/:credentialId/revoke',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant, role } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );
    requireRole(role, 'admin');

    const credentialId = request.params.credentialId;
    if (typeof credentialId !== 'string' || !isPublicId('credential', credentialId)) {
      throw new ApiError('not_found', 'No active credential with that id.');
    }

    // The owning tenant is part of the revoke's own filter, so a credential id from
    // another application cannot be revoked by naming it here.
    await revokeCredential({
      organizationId: tenant.organizationId,
      applicationId: tenant.applicationId,
      credentialId,
    });
    await appendAuditEvent(tenant, {
      action: 'console.credential.revoked',
      actorOxyUserId: consoleUser(request),
      subjectId: credentialId,
    });

    response.status(200).json({ credentialId, status: 'revoked' });
  },
);

consoleRouter.get(
  '/console/applications/:applicationId/webhook-endpoints',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );

    const endpoints = await endpointsWithHealth(tenant);
    response.status(200).json({
      endpoints: endpoints.map(({ endpoint, health }) => ({
        webhookEndpointId: endpoint.webhookEndpointId,
        url: endpoint.url,
        eventTypes: endpoint.eventTypes,
        status: endpoint.status,
        disabledReason: endpoint.disabledReason,
        createdAt: endpoint.createdAt.toISOString(),
        updatedAt: endpoint.updatedAt.toISOString(),
        health,
      })),
    });
  },
);

consoleRouter.post(
  '/console/applications/:applicationId/webhook-endpoints/:webhookEndpointId/rotate-secret',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant, role } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );
    requireRole(role, 'admin');

    if (!webhookSecretStorageConfigured()) {
      throw new ApiError(
        'service_unavailable',
        'Webhook secret storage is unavailable: this deployment has no usable WEBHOOK_SECRET_ENCRYPTION_KEY.',
      );
    }

    const webhookEndpointId = request.params.webhookEndpointId;
    if (
      typeof webhookEndpointId !== 'string' ||
      !isPublicId('webhookEndpoint', webhookEndpointId)
    ) {
      throw new ApiError('not_found', 'No such webhook endpoint.');
    }

    const parsed = RotateSecretSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'invalid_request',
        `overlapSeconds must be a whole number of seconds between 0 and ${MAX_SECRET_OVERLAP_SECONDS}.`,
      );
    }

    /**
     * The same service the §10.2 application route calls, not a second rotation
     * path. Two implementations of an overlap window is how a console rotation ends
     * up cutting over at a different instant from an API one, and the symptom is
     * signature failures at a tenant nobody can explain.
     */
    const rotated = await rotateWebhookSecret(tenant, webhookEndpointId, {
      ...(parsed.data.overlapSeconds === undefined
        ? {}
        : { overlapSeconds: parsed.data.overlapSeconds }),
    });

    await appendAuditEvent(tenant, {
      action: 'console.webhook.secret.rotated',
      actorOxyUserId: consoleUser(request),
      subjectId: webhookEndpointId,
    });

    response.status(200).json({
      webhookEndpointId,
      secret: {
        version: rotated.secret.version,
        value: rotated.secret.value,
        signingStartsAt: rotated.secret.signingStartsAt.toISOString(),
      },
      previousSecret: rotated.previous
        ? {
            version: rotated.previous.version,
            expiresAt: rotated.previous.expiresAt.toISOString(),
          }
        : null,
    });
  },
);

consoleRouter.get(
  '/console/applications/:applicationId/deliveries',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );

    const status = request.query.status;
    const endpointFilter = request.query.webhookEndpointId;

    const deliveries = await listTenantDeliveries(tenant, {
      ...(typeof status === 'string' && status !== ''
        ? { status: parseDeliveryStatus(status) }
        : {}),
      ...(typeof endpointFilter === 'string' && endpointFilter !== ''
        ? { webhookEndpointId: endpointFilter }
        : {}),
    });

    response.status(200).json({ deliveries: deliveries.map(deliveryView) });
  },
);

consoleRouter.post(
  '/console/applications/:applicationId/deliveries/:deliveryId/replay',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant, role } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );
    requireRole(role, 'admin');

    const deliveryId = request.params.deliveryId;
    if (typeof deliveryId !== 'string' || !isPublicId('webhookDelivery', deliveryId)) {
      throw new ApiError('not_found', 'No such webhook delivery.');
    }

    /**
     * §10.9's manual replay, and the reason it lives on the console rather than the
     * application API: an application replaying its own deliveries is not what
     * "replay manual" describes, and the delivery service already says so. The
     * tenant filter is inside `replayDeadLetteredDelivery`, so a delivery id from
     * another application answers 404 rather than being resurrected here.
     */
    const replayed = await replayDeadLetteredDelivery(tenant, deliveryId);
    await appendAuditEvent(tenant, {
      action: 'console.delivery.replayed',
      actorOxyUserId: consoleUser(request),
      subjectId: deliveryId,
    });

    response.status(200).json(deliveryView(replayed));
  },
);

consoleRouter.get(
  '/console/applications/:applicationId/deliveries/:deliveryId',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );

    const deliveryId = request.params.deliveryId;
    if (typeof deliveryId !== 'string' || !isPublicId('webhookDelivery', deliveryId)) {
      throw new ApiError('not_found', 'No such webhook delivery.');
    }

    const delivery = await findTenantDelivery(tenant, deliveryId);
    if (!delivery) {
      throw new ApiError('not_found', 'No such webhook delivery.');
    }

    response.status(200).json(deliveryView(delivery));
  },
);

consoleRouter.get(
  '/console/applications/:applicationId/cases',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );

    const status = request.query.status;
    const cursor = request.query.cursor;

    const page = await listCases(tenant, {
      ...(typeof status === 'string' && status !== '' ? { status: parseCaseStatus(status) } : {}),
      ...(typeof cursor === 'string' && cursor !== '' ? { cursor } : {}),
    });

    response.status(200).json(page);
  },
);

consoleRouter.get(
  '/console/applications/:applicationId/cases/:caseId',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );

    const caseId = request.params.caseId;
    if (typeof caseId !== 'string' || !isPublicId('case', caseId)) {
      throw new ApiError('not_found', 'No such case.');
    }

    const detail = await findCaseDetail(tenant, caseId);
    if (!detail) {
      throw new ApiError('not_found', 'No such case.');
    }

    response.status(200).json(detail);
  },
);

consoleRouter.get(
  '/console/applications/:applicationId/usage',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );

    response.status(200).json(await usageSummary(tenant, parseWindowDays(request.query.windowDays)));
  },
);

consoleRouter.get(
  '/console/applications/:applicationId/audit',
  ...requireConsoleSession(),
  async (request, response) => {
    const { tenant } = await resolveApplicationForMember(
      consoleUser(request),
      pathApplicationId(request.params.applicationId),
    );

    const caseFilter = request.query.caseId;
    const events = await auditTrail(tenant, {
      ...(typeof caseFilter === 'string' && isPublicId('case', caseFilter)
        ? { caseId: caseFilter }
        : {}),
    });

    response.status(200).json({
      events: events.map((event) => ({
        auditId: event.auditId,
        action: event.action,
        // Two actor fields, never merged into one: a leaked credential and a member of
        // the tenant's own team are different incidents with different responses.
        actorCredentialId: event.actorCredentialId,
        actorOxyUserId: event.actorOxyUserId,
        reportId: event.reportId,
        caseId: event.caseId,
        externalReportId: event.externalReportId,
        reason: event.reason,
        subjectId: event.subjectId,
        occurredAt: event.occurredAt.toISOString(),
      })),
    });
  },
);

/**
 * Query-parameter parsing, as refusals rather than silent fallbacks.
 *
 * An unrecognised `status` must not quietly become "no filter": an operator
 * filtering for `dead_letter` and receiving every delivery would read the result as
 * "everything is failing". A 400 that names the accepted values is the only answer
 * that cannot be misread.
 */
function parseDeliveryStatus(raw: string): WebhookDeliveryDocument['status'] {
  const known = ['pending', 'delivering', 'succeeded', 'dead_letter'] as const;
  const match = known.find((status) => status === raw);
  if (!match) {
    throw new ApiError('invalid_request', `status must be one of: ${known.join(', ')}.`);
  }
  return match;
}

function parseCaseStatus(raw: string): (typeof CASE_STATUSES)[number] {
  const match = CASE_STATUSES.find((status) => status === raw);
  if (!match) {
    throw new ApiError('invalid_request', `status must be one of: ${CASE_STATUSES.join(', ')}.`);
  }
  return match;
}

function parseWindowDays(raw: unknown): number {
  if (raw === undefined || raw === '') return DEFAULT_USAGE_WINDOW_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_USAGE_WINDOW_DAYS) {
    throw new ApiError(
      'invalid_request',
      `windowDays must be a whole number of days between 1 and ${MAX_USAGE_WINDOW_DAYS}.`,
    );
  }
  return days;
}
