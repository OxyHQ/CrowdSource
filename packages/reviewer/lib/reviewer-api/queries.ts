/**
 * React Query bindings for the Reviewer API.
 *
 * Every response passes through a projection in `redaction.ts` before it becomes
 * app state, and every assignment payload is additionally scanned for the fields
 * PLAN §9.1 forbids. The scan reports paths only: the values it would otherwise
 * report are case material, and case material does not go to logs.
 *
 * Every query here is keyed on the signed-in reviewer and gated on their access
 * token being ready — see `viewer.ts` for why neither is optional.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback } from 'react';

import { createScopedLogger } from '@/lib/logger';

import type {
  AssignmentPackage,
  RecusalSubmission,
  ReviewerCalibrationResultView,
  ReviewerCalibrationSubmission,
  ReviewerPreferencesUpdate,
  ReviewerProfileView,
  ReviewerTrainingView,
  ReviewHistoryPage,
  ReviewSubmission,
} from '@oxyhq/crowdsource-contracts';

import {
  clearActiveAssignment,
  refreshActiveAssignment,
  setActiveAssignment,
} from './active-assignment';
import {
  getAssignment,
  getHistory,
  getReviewerProfile,
  getTraining,
  postCalibration,
  postCompleteTrainingModule,
  postNextAssignment,
  postRecusal,
  postReview,
  postReviewerPreferences,
} from './client';
import { isAssignmentNotHeld, isReviewerApiUnavailable } from './errors';
import {
  projectAssignmentPackage,
  projectCalibrationResult,
  projectHistoryPage,
  projectIssuedAssignment,
  projectReviewerProfile,
  projectTrainingState,
  scanForForbiddenFields,
} from './redaction';
import { reviewerQueryKeys } from './query-keys';
import { useReviewerViewer } from './use-reviewer-viewer';
import { UNRESOLVED_VIEWER_KEY } from './viewer';

const logger = createScopedLogger('ReviewerApi');

/**
 * An unavailable endpoint and a lost assignment are answers, not transient
 * failures. Retrying either only delays the screen that already knows what to
 * say about them.
 */
function reviewerQueryRetry(failureCount: number, error: unknown): boolean {
  if (isReviewerApiUnavailable(error) || isAssignmentNotHeld(error)) {
    return false;
  }
  return failureCount < 2;
}

/**
 * Projects an assignment payload and raises the alarm if the server sent a field
 * §9.1 forbids.
 *
 * The projection is the enforcement — the forbidden fields are dropped whether
 * or not anyone is watching. This warning exists so that a backend regression is
 * visible while it is still cheap to fix.
 */
function alarmOnForbiddenFields(payload: unknown): void {
  const forbiddenPaths = scanForForbiddenFields(payload);
  if (forbiddenPaths.length > 0) {
    logger.warn('Assignment payload carried fields a reviewer must not see', {
      // Paths only. Never values.
      paths: forbiddenPaths,
    });
  }
}

export function useReviewerProfile(): UseQueryResult<ReviewerProfileView, Error> {
  const viewer = useReviewerViewer();
  return useQuery<ReviewerProfileView, Error>({
    queryKey: reviewerQueryKeys.profile(viewer.key ?? UNRESOLVED_VIEWER_KEY),
    queryFn: async () => projectReviewerProfile(await getReviewerProfile()),
    enabled: viewer.canQuery,
    retry: reviewerQueryRetry,
  });
}

export function useTrainingState(): UseQueryResult<ReviewerTrainingView, Error> {
  const viewer = useReviewerViewer();
  return useQuery<ReviewerTrainingView, Error>({
    queryKey: reviewerQueryKeys.training(viewer.key ?? UNRESOLVED_VIEWER_KEY),
    queryFn: async () => projectTrainingState(await getTraining()),
    enabled: viewer.canQuery,
    retry: reviewerQueryRetry,
  });
}

export function useReviewHistory(): UseInfiniteQueryResult<
  { pages: ReviewHistoryPage[]; pageParams: (string | null)[] },
  Error
> {
  const viewer = useReviewerViewer();
  return useInfiniteQuery<
    ReviewHistoryPage,
    Error,
    { pages: ReviewHistoryPage[]; pageParams: (string | null)[] },
    readonly string[],
    string | null
  >({
    queryKey: reviewerQueryKeys.history(viewer.key ?? UNRESOLVED_VIEWER_KEY),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => projectHistoryPage(await getHistory(pageParam)),
    getNextPageParam: (lastPage: ReviewHistoryPage) => lastPage.nextCursor,
    enabled: viewer.canQuery,
    retry: reviewerQueryRetry,
  });
}

/**
 * PLAN §4.1 — "Revisar siguiente caso" REQUESTS an assignment. The reviewer
 * expresses availability; the server decides which case, or that there is none.
 *
 * A `null` result is a legitimate answer: no case currently matches this
 * reviewer's categories, languages, consent and exposure headroom. It is not an
 * error and must not be presented as one.
 */
export function useRequestNextAssignment(): UseMutationResult<
  AssignmentPackage | null,
  Error,
  void
> {
  return useMutation({
    mutationFn: async () => {
      const payload = await postNextAssignment();
      if (payload === null || payload === undefined || payload === '') {
        return null;
      }
      alarmOnForbiddenFields(payload);
      /**
       * The ISSUED shape, which is the one that carries §8.7's token. Parsing it
       * as the plain package would drop the token silently, and every later call
       * on this assignment would then be refused with a 404 that looked like an
       * expiry.
       */
      return projectIssuedAssignment(payload);
    },
    onSuccess: (issued) => {
      if (issued !== null) {
        setActiveAssignment(issued);
      }
    },
  });
}

/**
 * Re-fetches the open assignment by the id it already holds.
 *
 * This is a REFRESH of something the server already handed out, not a lookup:
 * the id comes from the in-memory assignment, never from a route parameter or
 * anything a person could type.
 */
export function useRefreshAssignment(): UseMutationResult<AssignmentPackage, Error, string> {
  return useMutation({
    mutationFn: async (assignmentId: string) => {
      const payload = await getAssignment(assignmentId);
      alarmOnForbiddenFields(payload);
      // No token on this response: the one `next` issued is still the live one,
      // so the refresh replaces what is rendered and keeps what authorises.
      return projectAssignmentPackage(payload);
    },
    onSuccess: (assignment) => {
      refreshActiveAssignment(assignment);
    },
    onError: (error) => {
      if (isAssignmentNotHeld(error)) {
        clearActiveAssignment();
      }
    },
  });
}

export function useSubmitReview(): UseMutationResult<
  void,
  Error,
  { assignmentId: string; review: ReviewSubmission }
> {
  return useMutation({
    mutationFn: async ({ assignmentId, review }) => {
      await postReview(assignmentId, review);
    },
    onSuccess: () => {
      // The case leaves the device the moment the review is in. Nothing about it
      // is worth keeping, and the reviewer must not be able to revisit a vote.
      clearActiveAssignment();
    },
  });
}

/**
 * PLAN §13.7 — recusal is never penalised, so it is never made harder than
 * submitting. Same shape of call, same immediacy, no confirmation gauntlet.
 */
export function useRecuseFromAssignment(): UseMutationResult<
  void,
  Error,
  { assignmentId: string; recusal: RecusalSubmission }
> {
  return useMutation({
    mutationFn: async ({ assignmentId, recusal }) => {
      await postRecusal(assignmentId, recusal);
    },
    onSuccess: () => {
      clearActiveAssignment();
    },
  });
}

export function useUpdatePreferences(): UseMutationResult<
  ReviewerProfileView,
  Error,
  ReviewerPreferencesUpdate
> {
  const queryClient = useQueryClient();
  const viewer = useReviewerViewer();
  return useMutation({
    mutationFn: async (preferences) =>
      projectReviewerProfile(await postReviewerPreferences(preferences)),
    onSuccess: (profile) => {
      // The response IS the new profile, so write it rather than invalidate: a
      // reviewer who has just revoked consent for a category must not see the
      // old value while a refetch is in flight. It is written under the key of
      // the viewer who made the request, which is the only account it describes.
      queryClient.setQueryData(
        reviewerQueryKeys.profile(viewer.key ?? UNRESOLVED_VIEWER_KEY),
        profile,
      );
    },
  });
}

/**
 * PLAN §8.1 — one training module completed.
 *
 * The response is the refreshed training view, which is what the screen showing
 * the modules needs: reading it back from the profile would tell the reviewer
 * their state and not which module they just finished.
 */
export function useCompleteTrainingModule(): UseMutationResult<
  ReviewerTrainingView,
  Error,
  string
> {
  const queryClient = useQueryClient();
  const viewer = useReviewerViewer();
  return useMutation({
    mutationFn: async (moduleId) =>
      projectTrainingState(await postCompleteTrainingModule(moduleId)),
    onSuccess: (training) => {
      queryClient.setQueryData(
        reviewerQueryKeys.training(viewer.key ?? UNRESOLVED_VIEWER_KEY),
        training,
      );
      // Completing the last module can move an applicant to `calibrating`
      // (PLAN §8.1), and the state lives on the profile rather than here.
      void queryClient.invalidateQueries({
        queryKey: reviewerQueryKeys.profile(viewer.key ?? UNRESOLVED_VIEWER_KEY),
      });
    },
  });
}

/**
 * PLAN §9.7 — a calibration attempt, graded by the server.
 *
 * The result carries the score and which items were wrong, never which answer was
 * right. A pass can promote `calibrating` to `community`, so the profile is
 * invalidated either way.
 */
export function useSubmitCalibration(): UseMutationResult<
  ReviewerCalibrationResultView,
  Error,
  ReviewerCalibrationSubmission
> {
  const queryClient = useQueryClient();
  const viewer = useReviewerViewer();
  return useMutation({
    mutationFn: async (submission) => projectCalibrationResult(await postCalibration(submission)),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: reviewerQueryKeys.profile(viewer.key ?? UNRESOLVED_VIEWER_KEY),
      });
      void queryClient.invalidateQueries({
        queryKey: reviewerQueryKeys.training(viewer.key ?? UNRESOLVED_VIEWER_KEY),
      });
    },
  });
}

/**
 * Clears the open assignment without telling the server anything.
 *
 * This is the wellbeing screen's immediate exit (PLAN §4.1). It is not a
 * recusal — the assignment stays the reviewer's until it expires — it just stops
 * the material being on screen right now, which is the point.
 */
export function useStopShowingCase(): () => void {
  return useCallback(() => {
    clearActiveAssignment();
  }, []);
}
