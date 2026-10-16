import type { CaseEnvelope } from '@crowdsource.you/contracts';
import type { FileEvent } from '@oxy.so/core/server';

import type {
  EvidenceFileStatus,
  EvidenceFileVisibility,
  EvidenceReferenceState,
} from '../../db/postgres/schema/evidence';
import {
  EVIDENCE_FILE_STATUSES,
  EVIDENCE_FILE_VISIBILITIES,
} from '../../db/postgres/schema/evidence';
import type { TenantContext } from '../../db/tenantScope';
import type { EVIDENCE_WITHHELD_REASONS } from '../../domain/closedValues';
import { ApiError } from '../../http/apiError';
import { logger } from '../../utils/logger';
import { applications, organizations } from '../tenancy/tenancy.collections';
import { oxyFilesClient } from './oxyFiles';

/**
 * Evidence files: what a case's binary evidence may be, and when a jury is
 * shown it (oxy ADR 0043; `docs/architecture/evidence-files.md`).
 *
 * Two rules, both of which used to be absent:
 *
 *  1. **An application submits only evidence it owns** — a file owned by the
 *     tenant application's bound Oxy application, or by the tenant
 *     organization's Oxy account — that is active, and whose SHA-256 is the one
 *     the envelope declares. A reviewer's screen renders whatever file id a case
 *     carries, and every case keeps the files it names alive at Oxy, so without
 *     this an application could put anybody's file in front of a jury and pin it
 *     there. An owned copy is also what makes the evidence the case's: its author
 *     cannot delete it, and its owning application cannot either while a case
 *     references it.
 *  2. **A file Oxy says is not servable is withheld**, not left to fail in a
 *     reviewer's browser: blocked, trashed, deleted or private, or one Oxy
 *     refused CrowdSource a reference to. The jury is told material existed and
 *     cannot be shown (`retrievable: false`), which `content_unavailable` answers.
 */

export type EvidenceWithheldReason = (typeof EVIDENCE_WITHHELD_REASONS)[number];

/** One asset an envelope carries: its file, the bytes it declares, where it is. */
export interface EvidenceAsset {
  readonly fileId: string;
  readonly sha256: string;
  readonly path: string;
}

/** Every asset-backed resource's file, in envelope order. */
export function evidenceAssetsOf(envelope: CaseEnvelope): EvidenceAsset[] {
  const assets: EvidenceAsset[] = [];
  envelope.resources.forEach((resource, index) => {
    if ('asset' in resource) {
      assets.push({
        fileId: resource.asset.fileId,
        sha256: resource.asset.sha256,
        path: `resources.${index}.asset`,
      });
    }
  });
  return assets;
}

/** The distinct file ids an envelope's evidence is made of. */
export function evidenceFileIdsOf(envelope: CaseEnvelope): string[] {
  return [...new Set(evidenceAssetsOf(envelope).map((asset) => asset.fileId))];
}

/**
 * The refusal of evidence the application may not submit. A 422 whose cause is
 * the envelope, so the integrator fixes it rather than retrying it.
 */
export class EvidenceRefusal extends ApiError {
  constructor(message: string) {
    super('unprocessable_envelope', message);
  }
}

function unavailable(classification: string): ApiError {
  logger.error({ classification }, 'Evidence ownership could not be established');
  return new ApiError(
    'service_unavailable',
    'The evidence files could not be verified with Oxy. Retry this delivery.',
  );
}

/**
 * Refuses evidence the tenant does not own, or that is not the bytes declared.
 *
 * Fails CLOSED. Oxy unreachable, this service without `files:read`, or an answer
 * that does not reveal owners (only Oxy's own applications are told) is a 503:
 * the evidence may be genuine, so the integrator retries, and nothing unchecked
 * is stored. A file Oxy does not return, that is not active, or that another
 * owner holds is one refusal with one message — "not yours" and "no such file"
 * must not be told apart.
 */
export async function assertEvidenceOwnedByTenant(
  context: TenantContext,
  envelope: CaseEnvelope,
): Promise<void> {
  const assets = evidenceAssetsOf(envelope);
  if (assets.length === 0) return;

  const [application, organization] = await Promise.all([
    applications.findOne({ applicationId: context.applicationId }),
    organizations.findOne({ organizationId: context.organizationId }),
  ]);
  const ownerApplicationId = application?.oxyApplicationId ?? null;
  const ownerAccountId = organization?.oxyAccountId ?? null;

  let found: Awaited<ReturnType<ReturnType<typeof oxyFilesClient>['metadataByIds']>>;
  try {
    found = await oxyFilesClient().metadataByIds(evidenceFileIdsOf(envelope));
  } catch (_error: unknown) {
    throw unavailable('evidence_metadata_unavailable');
  }
  if (found.some((file) => !Object.hasOwn(file, 'ownerUserId'))) {
    throw unavailable('evidence_owner_unrevealed');
  }
  const byId = new Map(found.map((file) => [file.id, file]));

  for (const asset of assets) {
    const file = byId.get(asset.fileId);
    const owned =
      file !== undefined &&
      ((ownerApplicationId !== null && file.ownerApplicationId === ownerApplicationId) ||
        (ownerAccountId !== null && file.ownerUserId === ownerAccountId));
    if (!file || !owned || file.status !== 'active') {
      throw new EvidenceRefusal(
        `${asset.path}.fileId is not an active Oxy file owned by this application or its organization.`,
      );
    }
    if (asset.sha256 !== `sha256:${file.sha256.toLowerCase()}`) {
      throw new EvidenceRefusal(
        `${asset.path}.sha256 is not the SHA-256 of the Oxy file ${asset.path}.fileId names.`,
      );
    }
  }
}

// ── What a jury is shown ────────────────────────────────────────────────────

/** The state of one (case, file) that decides whether a jury sees it. */
export interface EvidenceFileState {
  readonly fileStatus: EvidenceFileStatus;
  readonly fileVisibility: EvidenceFileVisibility | null;
  readonly referenceState: EvidenceReferenceState;
}

/**
 * Why a jury must not be shown this file, or null when it may.
 *
 * Mirrored in SQL by `withheldEvidenceFileIds`; the real-database test holds
 * the two equal for every combination.
 */
export function withheldReason(state: EvidenceFileState): EvidenceWithheldReason | null {
  switch (state.fileStatus) {
    case 'deleted':
      return 'file_deleted';
    case 'blocked':
      return 'file_blocked';
    case 'trash':
      return 'file_trashed';
    case 'unknown':
      return 'file_unavailable';
    case 'active':
      break;
  }
  if (state.fileVisibility === 'private') return 'file_private';
  if (state.referenceState === 'refused') return 'file_unreferenceable';
  return null;
}

/**
 * The file's status as an event states it. The event TYPE wins where it names
 * the change — a `file.deleted` is a deletion whatever the status field says —
 * and a status this code does not know is `unknown`, which withholds.
 */
function statusAfter(event: FileEvent): EvidenceFileStatus {
  switch (event.type) {
    case 'file.deleted':
      return 'deleted';
    case 'file.blocked':
      return 'blocked';
    case 'file.trashed':
      return 'trash';
    default: {
      const stated = EVIDENCE_FILE_STATUSES.find((status) => status === event.file.status);
      return stated === undefined || stated === 'unknown' ? 'unknown' : stated;
    }
  }
}

export interface EvidenceFileChange extends EvidenceFileState {
  readonly fileStateAt: Date;
}

/**
 * What one file event makes of one evidence row, or null when it changes
 * nothing: the row's file is already deleted (terminal — no event revives a
 * tombstone), or the event is older than the last one applied (delivery is at
 * least once and in no promised order).
 *
 * A deletion also owes the removal of CrowdSource's reference, so Oxy's record
 * of who uses the file is exact; a block, a trash or a private file keeps it,
 * which is what brings the `file.unblocked`, `file.restored` or visibility
 * change that shows it to the jury again.
 */
export function evidenceAfterEvent(
  row: EvidenceFileState & { readonly fileStateAt: Date | null },
  event: FileEvent,
  receivedAt: Date,
): EvidenceFileChange | null {
  if (row.fileStatus === 'deleted') return null;
  const stated = new Date(event.occurredAt);
  const occurredAt = Number.isNaN(stated.getTime()) ? receivedAt : stated;
  if (row.fileStateAt !== null && occurredAt < row.fileStateAt) return null;

  const fileStatus = statusAfter(event);
  const visibility = EVIDENCE_FILE_VISIBILITIES.find((value) => value === event.file.visibility);
  const referenceState =
    fileStatus === 'deleted' &&
    (row.referenceState === 'pending' || row.referenceState === 'registered')
      ? 'removal_pending'
      : row.referenceState;

  return {
    fileStatus,
    fileVisibility: visibility ?? row.fileVisibility,
    referenceState,
    fileStateAt: occurredAt,
  };
}
