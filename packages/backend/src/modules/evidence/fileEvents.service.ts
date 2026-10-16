import type { FileEvent } from '@oxy.so/core/server';

import {
  applyFileEventToEvidence,
  lockEvidenceByFile,
  recordOxyFileEvent,
} from '../../db/postgres/repositories/evidenceFiles';
import { OXY_FILE_EVENT_TYPES, type OxyFileEventType } from '../../db/postgres/schema/evidence';
import { createTenantContext } from '../../db/tenantScope';
import { withTransaction } from '../../db/transaction';
import { logger } from '../../utils/logger';
import { appendAuditEvent } from '../audit/audit.collection';
import { evidenceAfterEvent, withheldReason, type EvidenceFileChange } from './evidenceFiles';

/**
 * Applying one verified Oxy file event (oxy ADR 0043 D9) to the evidence that
 * names the file, in every tenant.
 *
 * ONE transaction: the event is recorded in `oxy_file_events` (Oxy's event id
 * is the key, so a redelivery finds it and changes nothing), every evidence row
 * of the file is locked and moved to what the event says, and every case whose
 * jury now sees the file differently gets an audit row in its tenant's trail —
 * `evidence.withheld` with the reason, or `evidence.restored`. A recorded event
 * is therefore an applied one, and the 200 the receiver answers means exactly
 * that; a failure answers 500 and Oxy delivers it again.
 *
 * The file is looked up by its own id rather than by the event's `references`,
 * so a case whose reference is still owed (the worker has not run yet) is
 * covered too.
 */

export interface FileEventIntake {
  readonly duplicate: boolean;
  readonly rowsChanged: number;
}

function isKnownType(type: string): type is OxyFileEventType {
  return (OXY_FILE_EVENT_TYPES as readonly string[]).includes(type);
}

function differs(
  row: { fileStatus: string; fileVisibility: string | null; referenceState: string },
  next: EvidenceFileChange,
): boolean {
  return (
    row.fileStatus !== next.fileStatus ||
    row.fileVisibility !== next.fileVisibility ||
    row.referenceState !== next.referenceState
  );
}

export async function acceptFileEvent(
  event: FileEvent,
  receivedAt: Date = new Date(),
): Promise<FileEventIntake> {
  if (!isKnownType(event.type)) {
    // Unreachable while the SDK and `OXY_FILE_EVENT_TYPES` agree (a test holds
    // them equal); a type this code cannot interpret is not acknowledged.
    throw new Error(`Unknown file event type: ${event.type}`);
  }
  const type = event.type;

  return withTransaction(async (tx) => {
    const occurredAt = new Date(event.occurredAt);
    const recorded = await recordOxyFileEvent(tx, {
      eventId: event.id,
      type,
      fileId: event.file.id,
      occurredAt: Number.isNaN(occurredAt.getTime()) ? receivedAt : occurredAt,
      fileStatus: String(event.file.status),
      fileVisibility: String(event.file.visibility),
    });
    if (!recorded) return { duplicate: true, rowsChanged: 0 };

    const rows = await lockEvidenceByFile(tx, event.file.id);
    const changes: Array<EvidenceFileChange & { caseId: string; fileId: string }> = [];
    const audits: Array<{
      organizationId: string;
      applicationId: string;
      caseId: string;
      fileId: string;
      before: ReturnType<typeof withheldReason>;
      after: ReturnType<typeof withheldReason>;
    }> = [];

    for (const row of rows) {
      const next = evidenceAfterEvent(row, event, receivedAt);
      if (next === null) continue;
      if (differs(row, next)) changes.push({ ...next, caseId: row.caseId, fileId: row.fileId });
      const before = withheldReason(row);
      const after = withheldReason(next);
      if (before !== after) {
        audits.push({
          organizationId: row.organizationId,
          applicationId: row.applicationId,
          caseId: row.caseId,
          fileId: row.fileId,
          before,
          after,
        });
      }
    }

    await applyFileEventToEvidence(tx, { eventId: event.id, now: receivedAt, changes });

    // Last, because each one sets its tenant's parameters for the rest of the
    // transaction; the unscoped writes above need none.
    for (const audit of audits) {
      await appendAuditEvent(
        createTenantContext(audit.organizationId, audit.applicationId),
        audit.after === null
          ? { action: 'evidence.restored', caseId: audit.caseId, subjectId: audit.fileId }
          : {
              action: 'evidence.withheld',
              caseId: audit.caseId,
              subjectId: audit.fileId,
              reason: audit.after,
            },
        tx,
      );
    }

    if (audits.length > 0) {
      logger.info(
        {
          classification: 'evidence_file_event',
          eventId: event.id,
          type,
          rowsChanged: changes.length,
          withheld: audits.filter((audit) => audit.after !== null).length,
          restored: audits.filter((audit) => audit.after === null).length,
        },
        'An Oxy file event changed what juries are shown',
      );
    }
    return { duplicate: false, rowsChanged: changes.length };
  });
}
