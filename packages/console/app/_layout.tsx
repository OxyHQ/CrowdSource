// Import Reanimated early so it initializes before other modules. The console
// animates nothing itself, but Bloom's sheets and the SDK's account dialog do.
import 'react-native-reanimated';
import { PortalOutlet, PortalProvider } from '@oxyhq/bloom/portal';
import { BloomProvider } from '@oxyhq/bloom/provider';
import { useAuth } from '@oxyhq/services/ui/client';
import { Redirect, Slot, useSegments } from 'expo-router';
import React from 'react';

import { AppProviders } from '@/components/providers/AppProviders';
import { registerChunkErrorRecovery } from '@/lib/chunkReload';
import { oxyServices } from '@/lib/oxyServices';
import { queryClient } from '@/lib/queryClient';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';

import '../global.css';

// Register web chunk recovery before the first route can lazy-load.
registerChunkErrorRecovery();

/**
 * Resolve bare Oxy file ids to download URLs for Bloom's `useImageResolver()`.
 *
 * Registered once, at the root, so every avatar in the app and in the Oxy SDK's own
 * account screens resolves through this one chokepoint rather than a per-screen URL
 * helper. The console renders no tenant media of its own — the only images it shows
 * are the signed-in operator's avatar and whatever the SDK's dialogs draw.
 */
function resolveImageSource(fileId: string, variant?: string): string | undefined {
  const url = oxyServices.getFileDownloadUrl(fileId, variant);
  return url && url.startsWith('http') ? url : undefined;
}

export default function RootLayout() {
  return (
    // The single Bloom root — theme, haptics and image resolution at one depth.
    // Mounting those pieces separately is what lets one of them land too low, and
    // `useTheme()` throws for anything rendered beside a provider rather than under
    // it.
    <BloomProvider
      imageResolver={resolveImageSource}
      defaultMode="system"
      defaultColorPreset="green"
      persistKey={BLOOM_THEME_PERSIST_KEY}
      storage={BLOOM_THEME_STORAGE}
    >
      <AppProviders oxyServices={oxyServices} queryClient={queryClient}>
        <PortalProvider>
          <AuthRouter />
          <PortalOutlet />
        </PortalProvider>
      </AppProviders>
    </BloomProvider>
  );
}

/**
 * The SOLE authority for the `(auth)` ↔ `(console)` group swap.
 *
 * Child screens must never navigate across that boundary on the same signal: on a
 * cold load the child can commit first and leave the app on a blank route.
 *
 * `<Slot/>` rather than a `<Stack>`: the matched route flows in normal document
 * flow, which is what makes the body the scroller and therefore what makes
 * `position: sticky` work for the rail, the screen header and the toolbar. A native
 * stack clamps each scene in a viewport-height `position: absolute; inset: 0`
 * container, leaving sticky nothing taller to pin within.
 */
function AuthRouter() {
  const { isAuthenticated, isAuthResolved } = useAuth();
  const segments = useSegments();

  // `isAuthenticated: false` is UNDETERMINED until cold boot resolves, so routing
  // on it early would bounce a returning operator to sign-in on every reload.
  if (!isAuthResolved) {
    return null;
  }

  const inAuthGroup = segments[0] === '(auth)';
  if (!isAuthenticated && !inAuthGroup) {
    return <Redirect href="/sign-in" />;
  }
  if (isAuthenticated && inAuthGroup) {
    return <Redirect href="/" />;
  }

  return <Slot />;
}
