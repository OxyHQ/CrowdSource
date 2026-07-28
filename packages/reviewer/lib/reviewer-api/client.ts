/**
 * The Reviewer API client.
 *
 * Authentication is NOT handled here. `createLinkedClient` returns an HTTP
 * client bound to the one Oxy session that `OxyProvider` owns: its bearer stays
 * in lockstep with that session and its 401 path re-mints from the device
 * secret. The app therefore has no token provider, no `Authorization` header and
 * no auth routes of its own, which is the ecosystem rule and also the reason the
 * reviewer surface cannot be reached with anything but a real Oxy session.
 *
 * GET caching is off (the linked-client default): React Query is the single
 * cache authority for this backend, and a second, invisible cache underneath it
 * is how a submitted review comes back as still-pending.
 */

import { API_URL } from '@/config';
import { oxyServices } from '@/lib/oxyServices';

import {
  AssignmentNotHeldError,
  ReviewerApiUnavailableError,
  ReviewerApiUnreachableError,
  httpStatusOf,
} from './errors';

const linkedClient = oxyServices.createLinkedClient({ baseURL: API_URL, enableCache: false });

/**
 * A request that has not answered by now is not going to. Without this a failing
 * backend leaves a screen on a spinner rather than on the notice that says what
 * is wrong, which is the opposite of the point.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** PLAN §10.3 — every reviewer endpoint this app depends on, in one place. */
export const REVIEWER_ENDPOINTS = {
  profile: 'GET /v1/reviewer/profile',
  preferences: 'POST /v1/reviewer/preferences',
  onboarding: 'POST /v1/reviewer/onboarding',
  training: 'GET /v1/reviewer/training',
  nextAssignment: 'POST /v1/reviewer/assignments/next',
  assignment: 'GET /v1/reviewer/assignments/{id}',
  submitReview: 'POST /v1/reviewer/assignments/{id}/reviews',
  recuse: 'POST /v1/reviewer/assignments/{id}/recuse',
  history: 'GET /v1/reviewer/reviews',
} as const;

export type ReviewerEndpoint = (typeof REVIEWER_ENDPOINTS)[keyof typeof REVIEWER_ENDPOINTS];

/**
 * How to read a 404 from a given route, decided per endpoint rather than by
 * sniffing the error body.
 *
 * - `unavailable`: the route is a collection endpoint that always exists once
 *   mounted (it answers with an empty list, a `null` assignment or a profile).
 *   A 404 there can only mean the module is not deployed yet.
 * - `gone`: the route is scoped to one assignment, so once mounted a 404 means
 *   that assignment expired or was reassigned — the expected outcome of a
 *   replacement draw, not a fault.
 */
type NotFoundMeaning = 'unavailable' | 'gone';

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  endpoint: ReviewerEndpoint;
  notFound: NotFoundMeaning;
  body?: unknown;
}

/**
 * Issues one request and normalizes its failure modes.
 *
 * Returns the raw payload as `unknown` on purpose: nothing in the app consumes a
 * response without passing it through a projection in `redaction.ts` first.
 */
async function request({ method, path, endpoint, notFound, body }: RequestSpec): Promise<unknown> {
  try {
    return await linkedClient.client.request<unknown>({
      method,
      url: path,
      data: body,
      // ONE retry authority. The SDK's HttpService retries on its own schedule
      // and React Query retries on top of it, which multiplies out to a screen
      // that spins for the better part of a minute against a backend that is
      // simply not there. React Query owns the policy (see
      // `components/providers/constants.ts`); the transport just reports.
      retry: false,
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 404) {
      throw notFound === 'unavailable'
        ? new ReviewerApiUnavailableError(endpoint)
        : new AssignmentNotHeldError();
    }
    if (status === 403 || status === 401) {
      // The reviewer surface derives its permissions from the assignment
      // (PLAN §10.1). A refused assignment-scoped call means the assignment is
      // no longer theirs, which is a state, not an error to retry.
      if (notFound === 'gone') {
        throw new AssignmentNotHeldError();
      }
      throw error;
    }
    if (status === undefined) {
      // No HTTP status at all: the request never reached the API.
      throw new ReviewerApiUnreachableError(endpoint, error);
    }
    throw error;
  }
}

export function getReviewerProfile(): Promise<unknown> {
  return request({
    method: 'GET',
    path: '/v1/reviewer/profile',
    endpoint: REVIEWER_ENDPOINTS.profile,
    notFound: 'unavailable',
  });
}

export function putReviewerPreferences(body: unknown): Promise<unknown> {
  return request({
    method: 'POST',
    path: '/v1/reviewer/preferences',
    endpoint: REVIEWER_ENDPOINTS.preferences,
    notFound: 'unavailable',
    body,
  });
}

export function postOnboarding(body: unknown): Promise<unknown> {
  return request({
    method: 'POST',
    path: '/v1/reviewer/onboarding',
    endpoint: REVIEWER_ENDPOINTS.onboarding,
    notFound: 'unavailable',
    body,
  });
}

export function getTraining(): Promise<unknown> {
  return request({
    method: 'GET',
    path: '/v1/reviewer/training',
    endpoint: REVIEWER_ENDPOINTS.training,
    notFound: 'unavailable',
  });
}

/**
 * PLAN §4.1 — the ONLY way into a case.
 *
 * There is no companion "list cases" or "get case by id" call anywhere in this
 * module, and there is no route in the app that takes a case id. The server
 * issues an assignment or it does not.
 */
export function postNextAssignment(): Promise<unknown> {
  return request({
    method: 'POST',
    path: '/v1/reviewer/assignments/next',
    endpoint: REVIEWER_ENDPOINTS.nextAssignment,
    notFound: 'unavailable',
  });
}

export function getAssignment(assignmentId: string): Promise<unknown> {
  return request({
    method: 'GET',
    path: `/v1/reviewer/assignments/${encodeURIComponent(assignmentId)}`,
    endpoint: REVIEWER_ENDPOINTS.assignment,
    notFound: 'gone',
  });
}

export function postReview(assignmentId: string, body: unknown): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/reviewer/assignments/${encodeURIComponent(assignmentId)}/reviews`,
    endpoint: REVIEWER_ENDPOINTS.submitReview,
    notFound: 'gone',
    body,
  });
}

export function postRecusal(assignmentId: string, body: unknown): Promise<unknown> {
  return request({
    method: 'POST',
    path: `/v1/reviewer/assignments/${encodeURIComponent(assignmentId)}/recuse`,
    endpoint: REVIEWER_ENDPOINTS.recuse,
    notFound: 'gone',
    body,
  });
}

export function getHistory(cursor: string | null): Promise<unknown> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request({
    method: 'GET',
    path: `/v1/reviewer/reviews${query}`,
    endpoint: REVIEWER_ENDPOINTS.history,
    notFound: 'unavailable',
  });
}
