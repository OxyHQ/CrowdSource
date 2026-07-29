/**
 * The line between one reviewer and the next.
 *
 * A person can sign out or switch Oxy account without the page ever reloading,
 * and when they do, everything the previous account was shown has to be gone
 * before the new one can see a frame of it. Two things carry that risk:
 *
 * - the open assignment, which is CASE MATERIAL — the app's sharpest privacy
 *   rule is that it never outlives the sitting it was issued for;
 * - the reviewer query cache, which holds the previous account's standing,
 *   training progress and review history.
 *
 * Query keys are already scoped per viewer (`lib/reviewer-api/viewer.ts`), so
 * nothing here is load-bearing for CORRECTNESS of what renders. It is here so
 * the previous reviewer's data is actually DROPPED rather than left sitting in
 * memory until React Query's collection interval comes round.
 *
 * This is one of the few places an effect is the right tool: it synchronizes an
 * external, non-React store with an identity that changes underneath it, which
 * is exactly what `useSyncExternalStore` cannot express and derived state
 * cannot erase. `useLayoutEffect` rather than `useEffect` so the clear and the
 * re-render it triggers are both flushed before the browser paints — a case
 * that flashes for one frame under the wrong account has still been shown to
 * them. The ecosystem precedent is Mention's `AccountSwitchReset`.
 */

import { useQueryClient } from '@tanstack/react-query';
import React, { useLayoutEffect, useRef } from 'react';

import { clearActiveAssignment } from '@/lib/reviewer-api/active-assignment';
import { reviewerQueryKeys } from '@/lib/reviewer-api/query-keys';
import { useReviewerViewer } from '@/lib/reviewer-api/use-reviewer-viewer';
import { shouldDropPreviousViewer } from '@/lib/reviewer-api/viewer';

export function ReviewerIdentityBoundary({ children }: { children: React.ReactNode }) {
  const viewer = useReviewerViewer();
  const queryClient = useQueryClient();
  const previousViewerKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    // `null` means cold boot has not concluded. An identity that is not known
    // yet has not changed, and treating it as one would wipe the cache on every
    // page load for no reason.
    if (viewer.key === null) {
      return;
    }

    const previous = previousViewerKeyRef.current;
    previousViewerKeyRef.current = viewer.key;

    // The transition rule is `shouldDropPreviousViewer` — pure and tested there,
    // so the condition that protects one reviewer from the next is not folded
    // into an effect body where nothing can exercise it.
    if (!shouldDropPreviousViewer(previous, viewer.key)) {
      return;
    }

    clearActiveAssignment();
    // The whole namespace, not just the new viewer's slice: the entries worth
    // removing are precisely the ones belonging to the account being left.
    queryClient.removeQueries({ queryKey: reviewerQueryKeys.all });
  }, [viewer.key, queryClient]);

  return <>{children}</>;
}
