/**
 * The assignment currently open in this session — held in memory, and only in
 * memory.
 *
 * Three invariants meet in this file.
 *
 * **Nobody chooses the case they review.** There is no route in this app that
 * takes a case or assignment id, so there is no URL to copy, bookmark or share.
 * The only way an assignment gets here is `POST /v1/reviewer/assignments/next`
 * returning one. Reload the page and it is gone; the reviewer asks for work
 * again and the server decides, again.
 *
 * **Case material never reaches device storage.** This is a module-level
 * variable, not AsyncStorage and not the SDK session store. `clear()` is
 * synchronous and total, which is what makes the wellbeing screen's immediate
 * exit actually immediate.
 *
 * **The assignment token lives exactly as long as the assignment.** §8.7's token
 * authorises ONE case and is returned exactly once, by `next`; every later call
 * on that assignment presents it in `x-assignment-token`. It is held here, beside
 * the package it authorises, and never in `utils/storage.ts` or the SDK's session
 * store: a token that outlived the sitting would let a reload reopen material the
 * reviewer had closed, which is the opposite of what the wellbeing exit promises.
 * A reload loses the token, the reviewer asks again, and the server issues a new
 * one — which is also why the token rotating on every `next` costs nothing here.
 *
 * Read it with {@link useActiveAssignment}, never by importing the variable. The
 * React Compiler is enabled in this app (`app.config.js` → `experiments.
 * reactCompiler`), and a direct read of module-level mutable state inside a
 * memoized position freezes at the first value it ever saw.
 * `useSyncExternalStore` is the supported way to read an external store, and the
 * snapshot below is reference-stable while unchanged so it does not loop.
 */

import type { AssignmentPackage, IssuedAssignmentPackage } from '@oxyhq/crowdsource-contracts';
import { useSyncExternalStore } from 'react';

/**
 * What the session holds while a case is open: the renderable package, and the
 * token that authorises every further call about it.
 *
 * One object rather than two module variables, so they cannot get out of step —
 * a package without its token is an assignment every subsequent request would be
 * refused for, and a token without its package authorises something nothing is
 * showing.
 */
interface OpenAssignment {
  readonly assignment: AssignmentPackage;
  readonly token: string;
}

let open: OpenAssignment | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): OpenAssignment | null {
  return open;
}

/**
 * Server snapshot for the static web export's prerender pass. There is never an
 * assignment at build time, and returning the live variable would risk a
 * hydration mismatch.
 */
function getServerSnapshot(): OpenAssignment | null {
  return null;
}

/**
 * Opens an assignment, splitting the issued payload into what is rendered and
 * what authorises.
 *
 * Takes the ISSUED package specifically — the only response that carries a token
 * — so there is no way to open a case without one.
 */
export function setActiveAssignment(issued: IssuedAssignmentPackage): void {
  const { token, ...assignment } = issued;
  open = { assignment, token };
  emit();
}

/**
 * Replaces the rendered package of the case already open, keeping its token.
 *
 * This is the refresh path: `GET /assignments/:id` returns the package without a
 * token, because the token it was authorised with is still the live one.
 */
export function refreshActiveAssignment(assignment: AssignmentPackage): void {
  if (open === null || open.assignment.assignmentId !== assignment.assignmentId) {
    return;
  }
  open = { assignment, token: open.token };
  emit();
}

/**
 * Drops the open assignment, the token, and everything in it.
 *
 * Called on submit, on recusal, by the wellbeing screen's immediate exit, and
 * by `ReviewerIdentityBoundary` when the signed-in account changes. It is
 * deliberately synchronous: "stop showing me this now" must not wait on a
 * network round trip.
 */
export function clearActiveAssignment(): void {
  if (open === null) {
    return;
  }
  open = null;
  emit();
}

/** Reads the open assignment, subscribing the caller to changes. */
export function useActiveAssignment(): AssignmentPackage | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)?.assignment ?? null;
}

/**
 * The token for the open assignment, for the request layer only.
 *
 * Not a hook and not rendered anywhere. It is read at the moment a request is
 * built, so a screen never holds it and cannot put it in a log line, a query key
 * or a URL.
 */
export function activeAssignmentToken(assignmentId: string): string | null {
  return open !== null && open.assignment.assignmentId === assignmentId ? open.token : null;
}
