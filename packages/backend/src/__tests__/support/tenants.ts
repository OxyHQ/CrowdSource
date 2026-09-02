import { createHash, randomUUID } from 'node:crypto';

import {
  CaseEnvelopeSchema,
  type CaseEnvelope,
  type Resource,
} from '@oxyhq/crowdsource-contracts';

import { config } from '../../config';
import { pingPostgres } from '../../db/postgres/database';
import type { TenantContext } from '../../db/tenantScope';
import {
  BASELINE_POLICY_SET_ID,
  BASELINE_POLICY_VERSION,
} from '../../modules/policy/policyBaseline';
import {
  createApplication,
  createOrganization,
  issueApplicationCredential,
} from '../../modules/tenancy/provisioning.service';
import type { ApplicationScope } from '../../modules/tenancy/scopes';
import { drainOutbox } from '../../modules/outbox/outbox.dispatcher';

/**
 * Support for the integration tests, against disposable real PostgreSQL.
 *
 * Every test provisions its OWN organization and application. Nothing wipes a
 * collection between tests, because a shared wipe makes two test files running
 * in parallel able to delete each other's fixtures — and the failure that
 * produces looks exactly like a broken tenant filter, which is the one signal
 * these tests exist to give unambiguously.
 */

export async function startDatabase(): Promise<void> {
  /**
   * Gate the run on where it is about to write.
   *
   * The fallback URL deliberately names `unused-by-design`; reaching it means
   * global setup did not provision the disposable database. Refuse before any
   * test can write to a developer or shared database by accident.
   */
  if (config.databaseUrl.includes('unused-by-design')) {
    throw new Error(
      `The integration suite is pointed at '${config.databaseUrl}', which means ` +
        'vitest.globalSetup.ts did not create the disposable PostgreSQL database. Refusing to run.',
    );
  }

  await pingPostgres();
}

export async function stopDatabase(): Promise<void> {
  // The serial suite shares one disposable database. Global teardown owns it.
}

/**
 * Drives the outbox until an OUTCOME is true, rather than assuming one pass did
 * it.
 *
 * A single `drainOutbox()` is not enough because one pass is intentionally
 * bounded and can race a leased row. Waiting on the outcome asserts the domain
 * result instead of depending on a particular worker pass.
 *
 * Waiting on the outcome makes the assertion about what the domain ended up
 * doing instead of about which process happened to do it. Ten seconds is far
 * longer than any handler here takes, and the throw names what never arrived so
 * a genuine hang does not read as a timeout.
 */
export async function drainUntil(
  reached: () => Promise<boolean>,
  what: string,
  attempts = 400,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await drainOutbox();
    if (await reached()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`The outbox never reached: ${what}`);
}

export interface ProvisionedTenant {
  readonly organizationId: string;
  readonly applicationId: string;
  readonly token: string;
  readonly tenant: TenantContext;
}

const DEFAULT_SCOPES: readonly ApplicationScope[] = [
  'crowdsource:reports:write',
  'crowdsource:reports:read',
  'crowdsource:cases:read',
];

/** An organization, an application and a credential — the §15.2 preamble. */
export async function provisionTenant(
  scopes: readonly ApplicationScope[] = DEFAULT_SCOPES,
): Promise<ProvisionedTenant> {
  const organization = await createOrganization({
    name: 'Test Organization',
    slug: `test-${randomUUID()}`,
  });
  return provisionApplication(organization.organizationId, scopes);
}

/**
 * A second application under an EXISTING organization.
 *
 * The isolation tests need this shape specifically. One organization routinely
 * runs several products (§3), and a filter that scopes by organization alone
 * looks correct against two separate customers while leaking freely between one
 * customer's own applications — which is where a report from a private staging
 * app would show up in a public one.
 */
export async function provisionApplication(
  organizationId: string,
  scopes: readonly ApplicationScope[] = DEFAULT_SCOPES,
): Promise<ProvisionedTenant> {
  const application = await createApplication({ organizationId, name: 'Test Application' });
  const credential = await issueApplicationCredential({
    organizationId,
    applicationId: application.applicationId,
    scopes,
  });

  return {
    organizationId,
    applicationId: application.applicationId,
    token: credential.token,
    tenant: { organizationId, applicationId: application.applicationId },
  };
}

/**
 * A Case Envelope that the published contract actually accepts.
 *
 * Every field the contract requires is here, because ingress now parses with
 * `CaseEnvelopeSchema` (§7.2 step 2) and a fixture that skipped a required field
 * would make every test in the suite exercise the rejection path instead of the
 * one it names.
 *
 * The defaults are what a test that does not care wants: one text resource, one
 * allegation, the baseline policy, community review allowed. Everything a
 * deduplication test DOES care about — the subject id, the text, the reporter,
 * the policy — is an override, because those are exactly the axes along which
 * two reports must either merge or stay apart.
 */
export interface SampleEnvelopeOptions {
  readonly applicationId: string;
  readonly externalReportId?: string;
  readonly text?: string;
  readonly subjectExternalId?: string;
  readonly allegationCode?: string;
  /**
   * The language of the reported material.
   *
   * A second isolation axis alongside the taxonomy family, and the same kind of
   * axis: §8.2 requires a reviewer to have the case's language, so a pool
   * created with one language and a case created with another cannot see each
   * other. There are eleven families and more test files than that wanting an
   * exclusive pool, and the alternative — sharing a family between two blocks —
   * makes `POST /assignments/next` ambiguous for a reviewer holding two cases.
   */
  readonly language?: string;
  readonly reporterExternalId?: string;
  readonly policy?: { readonly policySetId: string; readonly version: string };
  readonly allowCommunityReview?: boolean;
  readonly retentionDays?: number;
  readonly reach?: number;
  readonly resourceUrl?: string;
  /**
   * Extra resources appended verbatim, for suites that need a resource type the
   * default envelope does not carry.
   *
   * Opt-in and appended rather than replacing, so no existing suite's fixture
   * changes shape: `res_post` stays the subject and stays first, which several
   * tests depend on by position.
   */
  readonly extraResources?: readonly Resource[];
}

export function sampleEnvelope(options: SampleEnvelopeOptions): CaseEnvelope {
  const text = options.text ?? 'Reported text';
  const reporterExternalId = options.reporterExternalId ?? 'reporter_1';

  /**
   * Parsed by the published contract on the way out.
   *
   * A fixture that drifts out of contract would otherwise make every test using
   * it exercise the 422 path while still reading as a test of something else.
   * This way the failure lands here, on the line that built the bad envelope.
   */
  return CaseEnvelopeSchema.parse({
    schemaVersion: 'crowdsource.case.v1',
    applicationId: options.applicationId,
    externalReportId: options.externalReportId ?? 'mention_report_1',
    subject: {
      externalId: options.subjectExternalId ?? 'post_987',
      type: 'social.post',
      primaryResourceId: 'res_post',
    },
    principalBindings: [
      { principalRef: 'author_1', type: 'local_user', externalPrincipalId: 'user_author' },
      {
        principalRef: 'reporter_1',
        type: 'local_user',
        externalPrincipalId: reporterExternalId,
      },
    ],
    resources: [
      {
        id: 'res_post',
        type: 'text',
        role: 'subject',
        language: options.language ?? 'es',
        data: { text },
        sha256: digestOf(text),
        authorPrincipalRef: 'author_1',
      },
      ...(options.resourceUrl === undefined
        ? []
        : [
            {
              id: 'res_link',
              type: 'link',
              role: 'context',
              data: { url: options.resourceUrl },
              sha256: digestOf(options.resourceUrl),
            },
          ]),
      ...(options.extraResources ?? []),
    ],
    relations:
      options.resourceUrl === undefined
        ? []
        : [{ from: 'res_post', type: 'refers_to', to: 'res_link' }],
    allegations: [
      {
        code: options.allegationCode ?? 'harassment.targeted_abuse',
        reporterPrincipalRef: 'reporter_1',
      },
    ],
    policy: options.policy ?? {
      policySetId: BASELINE_POLICY_SET_ID,
      version: BASELINE_POLICY_VERSION,
    },
    privacy: {
      retentionDays: options.retentionDays ?? 30,
      allowCommunityReview: options.allowCommunityReview ?? true,
    },
    ...(options.reach === undefined
      ? {}
      : { urgency: { hint: 'normal', reach: options.reach } }),
  });
}

/** The contract's only accepted digest form, over the UTF-8 bytes of a string. */
function digestOf(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * A whole `POST /v1/reports` body for one tenant.
 *
 * The contract requires the request's `externalReportId` and the envelope's to
 * agree, and the envelope's `applicationId` to be the credential's. Both are
 * checks worth having and neither is what most tests are about, so they are set
 * once here rather than restated at every call site — where a stale copy would
 * silently turn a test of something else into a test of the mismatch path.
 */
export function deliveryBody(
  tenant: ProvisionedTenant,
  externalReportId: string,
  options: Omit<SampleEnvelopeOptions, 'applicationId' | 'externalReportId'> = {},
): { externalReportId: string; envelope: CaseEnvelope } {
  return {
    externalReportId,
    envelope: sampleEnvelope({
      ...options,
      applicationId: tenant.applicationId,
      externalReportId,
    }),
  };
}
