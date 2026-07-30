/**
 * The line between one account and the next.
 *
 * A person can sign out or switch Oxy account without the page ever reloading, and
 * the two accounts are frequently not in the same organizations. What the previous
 * account was shown has to be gone before the new one can see a frame of it:
 * organization names, application ids, credential lists, case rows, and — on a
 * staff account — a cross-tenant trust table the next account may hold no role for
 * at all.
 *
 * Query keys are already scoped per viewer (`lib/console-api/viewer.ts`), so
 * nothing here is load-bearing for the CORRECTNESS of what renders. It is here so
 * the previous account's data is actually DROPPED rather than left sitting in
 * memory until React Query's collection interval comes round.
 *
 * This is one of the few places an effect is the right tool: it synchronizes an
 * external, non-React store with an identity that changes underneath it, which is
 * exactly what derived state cannot erase. `useLayoutEffect` rather than
 * `useEffect` so the clear and the re-render it triggers are both flushed before
 * the browser paints — a table that flashes for one frame under the wrong account
 * has still been shown to them.
 */

import { useQueryClient } from '@tanstack/react-query';
import React, { useLayoutEffect, useRef } from 'react';

import { consoleQueryKeys } from '@/lib/console-api/query-keys';
import { useConsoleViewer } from '@/lib/console-api/use-console-viewer';
import { shouldDropPreviousViewer } from '@/lib/console-api/viewer';

export function ConsoleIdentityBoundary({ children }: { children: React.ReactNode }) {
  const viewer = useConsoleViewer();
  const queryClient = useQueryClient();
  const previousViewerKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    // `null` means cold boot has not concluded. An identity that is not known yet
    // has not changed, and treating it as one would wipe the cache on every page
    // load for no reason.
    if (viewer.key === null) {
      return;
    }

    const previous = previousViewerKeyRef.current;
    previousViewerKeyRef.current = viewer.key;

    // The transition rule is `shouldDropPreviousViewer` — pure and tested there,
    // so the condition that protects one account from the next is not folded into
    // an effect body where nothing can exercise it.
    if (!shouldDropPreviousViewer(previous, viewer.key)) {
      return;
    }

    // The whole namespace, not just the new viewer's slice: the entries worth
    // removing are precisely the ones belonging to the account being left.
    queryClient.removeQueries({ queryKey: consoleQueryKeys.all });
  }, [viewer.key, queryClient]);

  return <>{children}</>;
}
