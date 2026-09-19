import { Router, type Request } from 'express';
import {
  COMMUNITY_NOTE_SUBJECTS_PER_LOOKUP_MAX,
  CommunityNoteAssignmentRequestSchema,
  CommunityNoteRatingSubmissionSchema,
  CommunityNoteSubmissionSchema,
  CommunityNoteWithdrawalSchema,
  ExternalIdSchema,
} from '@crowdsource.you/contracts';

import { ApiError } from '../../http/apiError';
import { parseOrThrow } from '../../http/parseBody';
import { isPublicId } from '../../utils/identifiers';
import {
  requestCredentialId,
  requestTenant,
  requireServiceCredential,
} from '../tenancy/serviceCredentialAuth';
import {
  communityNoteRatingView,
  communityNoteRatingsBy,
  communityNoteView,
  communityNotesWrittenBy,
  issueCommunityNoteAssignments,
  rateCommunityNote,
  shownCommunityNotes,
  withdrawCommunityNote,
  writeCommunityNote,
} from './communityNotes.service';

/**
 * Community notes over the application API (the community notes ADR).
 *
 * The application acts for its users, naming each by its own opaque principal id,
 * exactly as it files reports and appeals: CrowdSource never sees or authenticates
 * an application's users. The tenant comes from the credential, never the body.
 */
export const communityNotesRouter: Router = Router();

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

function readIdempotencyKey(request: Request): string {
  const value = request.get('idempotency-key')?.trim();
  if (!value) {
    throw new ApiError('invalid_request', 'The Idempotency-Key header is required.');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ApiError(
      'invalid_request',
      'The Idempotency-Key header must be 1-255 characters of letters, digits, dot, colon, underscore or hyphen.',
    );
  }
  return value;
}

function readNoteId(request: Request): string {
  const noteId = request.params.noteId;
  if (typeof noteId !== 'string' || !isPublicId('communityNote', noteId)) {
    throw new ApiError('not_found', 'No such community note.');
  }
  return noteId;
}

function readPrincipalId(request: Request): string {
  return parseOrThrow(ExternalIdSchema, request.params.principalId, 'The principal id is not valid.');
}

communityNotesRouter.post(
  '/community-notes',
  requireServiceCredential('crowdsource:community-notes:write'),
  async (request, response) => {
    const tenant = requestTenant(request);
    const submission = parseOrThrow(CommunityNoteSubmissionSchema, request.body, 'The community note is not valid.');
    const written = await writeCommunityNote(tenant, submission, {
      idempotencyKey: readIdempotencyKey(request),
      credentialId: requestCredentialId(request),
    });
    response.status(written.replayed ? 200 : 201).json(communityNoteView(written.note));
  },
);

communityNotesRouter.post(
  '/community-notes/assignments',
  requireServiceCredential('crowdsource:community-notes:write'),
  async (request, response) => {
    const tenant = requestTenant(request);
    const assignmentRequest = parseOrThrow(
      CommunityNoteAssignmentRequestSchema,
      request.body,
      'The assignment request is not valid.',
    );
    const assignments = await issueCommunityNoteAssignments(tenant, assignmentRequest, {
      idempotencyKey: readIdempotencyKey(request),
      credentialId: requestCredentialId(request),
    });
    response.status(200).json({ assignments });
  },
);

communityNotesRouter.post(
  '/community-notes/:noteId/withdraw',
  requireServiceCredential('crowdsource:community-notes:write'),
  async (request, response) => {
    const tenant = requestTenant(request);
    const noteId = readNoteId(request);
    const { authorPrincipalId } = parseOrThrow(
      CommunityNoteWithdrawalSchema,
      request.body,
      'The withdrawal is not valid.',
    );
    readIdempotencyKey(request);
    const note = await withdrawCommunityNote(tenant, noteId, authorPrincipalId, requestCredentialId(request));
    response.status(200).json(communityNoteView(note));
  },
);

communityNotesRouter.post(
  '/community-notes/:noteId/ratings',
  requireServiceCredential('crowdsource:community-notes:write'),
  async (request, response) => {
    const tenant = requestTenant(request);
    const noteId = readNoteId(request);
    const submission = parseOrThrow(CommunityNoteRatingSubmissionSchema, request.body, 'The rating is not valid.');
    const rated = await rateCommunityNote(tenant, noteId, submission, {
      idempotencyKey: readIdempotencyKey(request),
      credentialId: requestCredentialId(request),
    });
    response.status(rated.replayed ? 200 : 201).json(communityNoteRatingView(rated.rating));
  },
);

/**
 * The shown note for each subject: `?subjects=post_1,post_2`. Unaudited on
 * purpose — it is the read a feed page makes, and an audit row per page view
 * would drown every row that means something.
 */
communityNotesRouter.get(
  '/community-notes/shown',
  requireServiceCredential('crowdsource:community-notes:read'),
  async (request, response) => {
    const tenant = requestTenant(request);
    const raw = typeof request.query.subjects === 'string' ? request.query.subjects : '';
    const subjects = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
    if (subjects.length === 0 || subjects.length > COMMUNITY_NOTE_SUBJECTS_PER_LOOKUP_MAX) {
      throw new ApiError(
        'invalid_request',
        `Name between 1 and ${COMMUNITY_NOTE_SUBJECTS_PER_LOOKUP_MAX} subjects in the subjects query parameter.`,
      );
    }
    for (const subject of subjects) parseOrThrow(ExternalIdSchema, subject, 'A subject id is not valid.');
    response.status(200).json({ notes: await shownCommunityNotes(tenant, subjects) });
  },
);

communityNotesRouter.get(
  '/community-notes/principals/:principalId/notes',
  requireServiceCredential('crowdsource:community-notes:read'),
  async (request, response) => {
    const tenant = requestTenant(request);
    response.status(200).json({ notes: await communityNotesWrittenBy(tenant, readPrincipalId(request)) });
  },
);

communityNotesRouter.get(
  '/community-notes/principals/:principalId/ratings',
  requireServiceCredential('crowdsource:community-notes:read'),
  async (request, response) => {
    const tenant = requestTenant(request);
    response.status(200).json({ ratings: await communityNoteRatingsBy(tenant, readPrincipalId(request)) });
  },
);
