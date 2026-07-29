/**
 * The assignment currently open in this session — held in memory, and only in
 * memory.
 *
 * Two invariants meet in this file.
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
 * Read it with {@link useActiveAssignment}, never by importing the variable. The
 * React Compiler is enabled in this app (`app.config.js` → `experiments.
 * reactCompiler`), and a direct read of module-level mutable state inside a
 * memoized position freezes at the first value it ever saw.
 * `useSyncExternalStore` is the supported way to read an external store, and the
 * snapshot below is reference-stable while unchanged so it does not loop.
 */

import { useSyncExternalStore } from 'react';

import type { AssignmentPackage } from './types';

let activeAssignment: AssignmentPackage | null = null;
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

function getSnapshot(): AssignmentPackage | null {
  return activeAssignment;
}

/**
 * Server snapshot for the static web export's prerender pass. There is never an
 * assignment at build time, and returning the live variable would risk a
 * hydration mismatch.
 */
function getServerSnapshot(): AssignmentPackage | null {
  return null;
}

/** Replaces the open assignment. Passing `null` closes it. */
export function setActiveAssignment(assignment: AssignmentPackage | null): void {
  if (activeAssignment === assignment) {
    return;
  }
  activeAssignment = assignment;
  emit();
}

/**
 * Drops the open assignment and everything in it.
 *
 * Called on submit, on recusal, by the wellbeing screen's immediate exit, and
 * by `ReviewerIdentityBoundary` when the signed-in account changes. It is
 * deliberately synchronous: "stop showing me this now" must not wait on a
 * network round trip.
 */
export function clearActiveAssignment(): void {
  setActiveAssignment(null);
}

/** Reads the open assignment, subscribing the caller to changes. */
export function useActiveAssignment(): AssignmentPackage | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
