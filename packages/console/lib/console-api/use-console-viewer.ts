/**
 * Feeds live Oxy auth state into the identity rules in `viewer.ts`.
 *
 * The whole of this module is the wiring: which fields of `useAuth()` the rule
 * reads. The rule itself is next door, pure and tested there, so this file has
 * nothing in it that can be wrong without being obvious.
 */

import { useAuth } from '@oxyhq/services/ui/client';
import { useMemo } from 'react';

import { resolveViewer, type ConsoleViewer } from './viewer';

/** Reads the current viewer. Safe to call from any component under `OxyProvider`. */
export function useConsoleViewer(): ConsoleViewer {
  const { user, isAuthenticated, isAuthResolved, canUsePrivateApi } = useAuth();
  const userId = user?.id ?? null;

  return useMemo(
    () => resolveViewer({ isAuthResolved, isAuthenticated, userId, canUsePrivateApi }),
    [isAuthResolved, isAuthenticated, userId, canUsePrivateApi],
  );
}
