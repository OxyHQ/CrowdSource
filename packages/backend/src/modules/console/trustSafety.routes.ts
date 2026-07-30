import { Router } from 'express';
import { z } from 'zod';

import { ApiError } from '../../http/apiError';
import { isPublicId } from '../../utils/identifiers';
import { applications, organizations } from '../tenancy/tenancy.collections';
import {
  APPLICATION_STANDINGS,
  STANDING_REASONS,
  type ApplicationTrustDocument,
} from '../trust/applicationTrust.collection';
import {
  applicationCountsByStanding,
  listApplicationTrust,
  setApplicationStanding,
} from '../trust/applicationTrust.service';
import {
  countCasesByStatusAcrossTenants,
  countDecisionsByOutcomeAcrossTenants,
  findEscalatedCasesAcrossTenants,
  summariseReviewActivityAcrossTenants,
} from '../trust/crossTenantReads';
import {
  deliveryCountsAcrossTenants,
  listDeadLetteredDeliveriesAcrossTenants,
} from '../webhooks/delivery.service';
import { requestStaff, requireStaffRole } from './consoleAuth';
import { appendStaffAuditEvent } from './staffAudit.collection';

/**
 * The Trust & Safety API (§4.3, §10.1's "sesión Oxy con roles internos y
 * autorización explícita").
 *
 * A different caller class from the application API and a different AUTHORIZATION
 * from the developer console, even though it shares the latter's authentication: an
 * Oxy session plus a role on a `trust_safety_staff` row. Every Oxy account in
 * existence satisfies the session; a handful satisfy the role.
 *
 * ## What is here, and what is deliberately not
 *
 * These routes see ACROSS tenants, which is the whole point of the surface — and
 * therefore the reason each one is confined to collections that are unscoped by
 * design and to projections that carry no case material:
 *
 *  - application standing and its quality signals (`app_trust_snapshots`),
 *  - the dead-letter queue across tenants (`webhook_deliveries`), projected without
 *    the `body` field, which holds the exact signed bytes of an event.
 *
 * §4.3's escalated queue and §16.4's platform metrics come from
 * `../trust/crossTenantReads` — specific NAMED queries with their projections baked in,
 * in the one module allowlisted to read across tenants. Not a general
 * `findAcrossTenants(filter)`: that would control who may call but not what they may ask,
 * and a cross-tenant read of `cases` is a privacy boundary before it is a tenancy one.
 * The queue therefore carries triage fields only, and the metrics are scalars — an
 * aggregate that never returns a document cannot leak one.
 *
 * §4.3's cross-application INCIDENTS are still absent: §12.9 puts that correlation behind
 * an `Incident` object that does not exist, and nothing sets `incidentId` yet. Appeals and
 * suspect-reviewer auditing are absent too — see the report accompanying this change.
 */

export const trustSafetyRouter: Router = Router();

const SetStandingSchema = z.strictObject({
  standing: z.enum(APPLICATION_STANDINGS),
  reason: z.enum(STANDING_REASONS),
  /** Optional, and only ever able to WITHHOLD — see `setApplicationStanding`. */
  globalReputationEffectsAllowed: z.boolean().optional(),
});

function trustView(
  trust: ApplicationTrustDocument,
  names: { readonly organizationName: string | null; readonly applicationName: string | null },
): Record<string, unknown> {
  return {
    applicationId: trust.applicationId,
    organizationId: trust.organizationId,
    organizationName: names.organizationName,
    applicationName: names.applicationName,
    standing: trust.standing,
    globalReputationEffectsAllowed: trust.globalReputationEffectsAllowed,
    evidenceIntegrity: trust.evidenceIntegrity,
    identityBindingReliability: trust.identityBindingReliability,
    policyQuality: trust.policyQuality,
    lastStandingReason: trust.lastStandingReason,
    standingChangedAt: trust.standingChangedAt?.toISOString() ?? null,
    standingChangedByOxyUserId: trust.standingChangedByOxyUserId,
    updatedAt: trust.updatedAt.toISOString(),
  };
}

async function namesFor(
  trust: ApplicationTrustDocument,
): Promise<{ organizationName: string | null; applicationName: string | null }> {
  const [organization, application] = await Promise.all([
    organizations.findOne({ organizationId: trust.organizationId }),
    applications.findOne({ applicationId: trust.applicationId }),
  ]);
  return {
    organizationName: organization?.name ?? null,
    applicationName: application?.name ?? null,
  };
}

/**
 * `GET /v1/trust-safety/applications` — standing across every application (§4.3).
 *
 * Readable by `policy` as well as `security`: deciding whether a taxonomy or a policy
 * version is working means looking at which applications are producing overturned
 * decisions, and splitting that read behind two routes would only mean maintaining
 * two.
 */
trustSafetyRouter.get(
  '/trust-safety/applications',
  ...requireStaffRole('security', 'policy'),
  async (request, response) => {
    const standing = request.query.standing;
    if (standing !== undefined && typeof standing === 'string' && standing !== '') {
      if (!APPLICATION_STANDINGS.some((known) => known === standing)) {
        throw new ApiError(
          'invalid_request',
          `standing must be one of: ${APPLICATION_STANDINGS.join(', ')}.`,
        );
      }
    }

    const rows = await listApplicationTrust(
      typeof standing === 'string' && standing !== ''
        ? { standing: APPLICATION_STANDINGS.find((known) => known === standing) }
        : {},
    );

    const views: Record<string, unknown>[] = [];
    for (const trust of rows) {
      views.push(trustView(trust, await namesFor(trust)));
    }

    const staff = requestStaff(request);
    await appendStaffAuditEvent({
      action: 'staff.applications.read',
      actorOxyUserId: staff.oxyUserId,
      roles: staff.roles,
    });

    response.status(200).json({ applications: views });
  },
);

/**
 * `POST /v1/trust-safety/applications/{id}/standing` — promotion and restriction
 * (§15.10's "app trust y promoción sandbox a trusted").
 *
 * `security` only. This is the single most consequential write on the surface: it
 * decides whether an application may ingest at all and whether its decisions may ever
 * move an Oxy Trust figure, and §11.13 puts a technical review, an identity
 * verification and a quality period behind the promotion. A `policy` operator
 * adjusting a taxonomy has no business granting it.
 *
 * The reason is a CODE from a closed vocabulary, not a message. This row is read on
 * an operator screen and kept indefinitely, and a free-text field next to a case is
 * where a fragment of reported material eventually lands.
 */
trustSafetyRouter.post(
  '/trust-safety/applications/:applicationId/standing',
  ...requireStaffRole('security'),
  async (request, response) => {
    const applicationId = request.params.applicationId;
    if (typeof applicationId !== 'string' || !isPublicId('application', applicationId)) {
      throw new ApiError('not_found', 'No such application.');
    }

    const parsed = SetStandingSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'invalid_request',
        `A standing change needs one of ${APPLICATION_STANDINGS.join(', ')} and one of the reasons ${STANDING_REASONS.join(', ')}.`,
      );
    }

    const updated = await setApplicationStanding({
      applicationId,
      standing: parsed.data.standing,
      reason: parsed.data.reason,
      // Taken from the authenticated staff row, never from the body: "who changed
      // this" is worthless if the actor is a value the actor supplies.
      byOxyUserId: requestStaff(request).oxyUserId,
      ...(parsed.data.globalReputationEffectsAllowed === undefined
        ? {}
        : { globalReputationEffectsAllowed: parsed.data.globalReputationEffectsAllowed }),
    });

    await appendStaffAuditEvent({
      action: 'staff.standing.changed',
      actorOxyUserId: requestStaff(request).oxyUserId,
      roles: requestStaff(request).roles,
      applicationId,
    });

    response.status(200).json(trustView(updated, await namesFor(updated)));
  },
);

/**
 * `GET /v1/trust-safety/deliveries/dead-letter` — the DLQ across tenants (§10.9).
 *
 * §10.9 promises the tenant an alert and a manual replay; this is the other half, the
 * one an operator needs when several tenants stop receiving at once — which is the
 * shape of a fault on our side rather than on theirs.
 *
 * Projected without `body`. The delivery row carries the exact signed bytes of the
 * event, and a cross-tenant reader has no relationship with the case they name.
 */
trustSafetyRouter.get(
  '/trust-safety/deliveries/dead-letter',
  ...requireStaffRole('security'),
  async (request, response) => {
    const deliveries = await listDeadLetteredDeliveriesAcrossTenants();
    const staff = requestStaff(request);
    await appendStaffAuditEvent({
      action: 'staff.deadletter.read',
      actorOxyUserId: staff.oxyUserId,
      roles: staff.roles,
    });

    response.status(200).json({
      deliveries: deliveries.map((delivery) => ({
        deliveryId: delivery.deliveryId,
        organizationId: delivery.organizationId,
        applicationId: delivery.applicationId,
        webhookEndpointId: delivery.webhookEndpointId,
        eventId: delivery.eventId,
        eventType: delivery.eventType,
        attemptCount: delivery.attemptCount,
        lastResponseStatus: delivery.lastResponseStatus,
        deadLetterReason: delivery.deadLetterReason,
        deadLetteredAt: delivery.deadLetteredAt?.toISOString() ?? null,
        replayCount: delivery.replayCount,
      })),
    });
  },
);

/**
 * `GET /v1/trust-safety/escalated` — §4.3's escalated queue, across every tenant.
 *
 * Triage fields only: what kind of case it is, where it routed, when. No content, no
 * reporter, no panel — the projection is baked into the named query rather than applied
 * here, so this handler cannot widen it and neither can the next one.
 */
trustSafetyRouter.get(
  '/trust-safety/escalated',
  ...requireStaffRole('security', 'policy', 'appeals'),
  async (request, response) => {
    const cases = await findEscalatedCasesAcrossTenants();
    const staff = requestStaff(request);
    await appendStaffAuditEvent({
      action: 'staff.escalated.read',
      actorOxyUserId: staff.oxyUserId,
      roles: staff.roles,
    });

    response.status(200).json({ cases });
  },
);

/**
 * `GET /v1/trust-safety/metrics` — §16.4's platform figures, as scalars.
 *
 * Counts and rates only. An aggregate that never returns a document cannot leak one,
 * which is why the metrics went this way rather than through a projected read: it is a
 * far cheaper property to keep honest.
 *
 * `unavailable` still names what genuinely cannot be computed, because a dashboard
 * reading an absent key as zero is the failure the field exists to prevent — and the list
 * is now short and specific rather than covering for a missing primitive.
 */
trustSafetyRouter.get(
  '/trust-safety/metrics',
  ...requireStaffRole('security', 'policy'),
  async (request, response) => {
    const staff = requestStaff(request);
    await appendStaffAuditEvent({
      action: 'staff.metrics.read',
      actorOxyUserId: staff.oxyUserId,
      roles: staff.roles,
    });

    const [applicationsByStanding, deliveries, casesByStatus, decisionsByOutcome, reviews] =
      await Promise.all([
        applicationCountsByStanding(),
        deliveryCountsAcrossTenants(),
        countCasesByStatusAcrossTenants(),
        countDecisionsByOutcomeAcrossTenants(),
        summariseReviewActivityAcrossTenants(),
      ]);

    const attempted = deliveries.succeeded + deliveries.deadLetter;
    const decided = Object.values(decisionsByOutcome).reduce((total, count) => total + count, 0);

    response.status(200).json({
      applicationsByStanding,
      deliveries: {
        ...deliveries,
        // Null and not zero when nothing has been attempted: a success rate of 0%
        // on an empty deployment is the most alarming possible way to say "no data".
        successRate: attempted === 0 ? null : deliveries.succeeded / attempted,
      },
      casesByStatus,
      decisionsByOutcome,
      /**
       * §16.4's `inconclusive_rate`, computed here rather than stored.
       *
       * Its own figure and never folded into `no_violation`: "the jury reviewed this and
       * could not agree" is a different outcome from "the jury found no violation", and a
       * metric that merged them would be the first place that invariant eroded.
       */
      inconclusiveRate: decided === 0 ? null : decisionsByOutcome.inconclusive / decided,
      reviews,
      unavailable: [
        // Needs the age of the oldest undecided case per queue, which is a time-window
        // aggregation rather than a count; worth adding, not free.
        'case_queue_age_seconds',
        // Both need appeals, which are not built: an appeal is what creates the second
        // decision revision these rates are computed from.
        'appeal_rate',
        'overturn_rate',
        // Needs per-reviewer exposure, which no cross-tenant read returns by design.
        'reviewer_exposure_units',
      ],
    });
  },
);
