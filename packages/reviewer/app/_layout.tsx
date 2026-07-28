// Import Reanimated early so it initializes before other modules.
import 'react-native-reanimated';
import { BloomHapticsProvider } from '@oxyhq/bloom/hooks';
import { ImageResolverProvider } from '@oxyhq/bloom/image-resolver';
import { Outlet as PortalOutlet, Provider as PortalProvider } from '@oxyhq/bloom/portal';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { useAuth } from '@oxyhq/services/ui/client';
import { Redirect, Slot, Stack, useSegments } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';
import { enableFreeze } from 'react-native-screens';

import { AppProviders } from '@/components/providers/AppProviders';
import { registerChunkErrorRecovery } from '@/lib/chunkReload';
import { oxyServices } from '@/lib/oxyServices';
import { queryClient } from '@/lib/queryClient';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';

import '../global.css';

// Freeze blurred screens so their state and scroll position survive navigation,
// and register web chunk recovery before the first route can lazy-load.
enableFreeze(true);
registerChunkErrorRecovery();

/**
 * Resolve bare Oxy file ids to download URLs for Bloom's `useImageResolver()`.
 * Registered once, at the root: every avatar in the app and in the Oxy SDK's own
 * account screens resolves through this one chokepoint, never a per-screen URL
 * helper.
 */
function resolveImageSource(fileId: string, variant?: string): string | undefined {
  const url = oxyServices.getFileDownloadUrl(fileId, variant);
  return url && url.startsWith('http') ? url : undefined;
}

export default function RootLayout() {
  return (
    <ImageResolverProvider value={resolveImageSource}>
      <BloomThemeProvider
        defaultMode="system"
        defaultColorPreset="blue"
        persistKey={BLOOM_THEME_PERSIST_KEY}
        storage={BLOOM_THEME_STORAGE}
      >
        <BloomHapticsProvider>
          <AppProviders oxyServices={oxyServices} queryClient={queryClient}>
            <PortalProvider>
              <AuthRouter />
              <PortalOutlet />
            </PortalProvider>
          </AppProviders>
        </BloomHapticsProvider>
      </BloomThemeProvider>
    </ImageResolverProvider>
  );
}

/**
 * The SOLE authority for the `(auth)` ↔ `(app)` group swap.
 *
 * Child screens must never navigate across that boundary on the same signal: on
 * a cold load the child can commit first and leave the app on a blank route.
 */
function AuthRouter() {
  const { isAuthenticated, isAuthResolved } = useAuth();
  const segments = useSegments();

  // `isAuthenticated: false` is UNDETERMINED until cold boot resolves, so
  // routing on it early would bounce a returning reviewer to sign-in.
  if (!isAuthResolved) {
    return null;
  }

  const inAuthGroup = segments[0] === '(auth)';
  if (false && !isAuthenticated && !inAuthGroup) {
    return <Redirect href="/sign-in" />;
  }
  if (isAuthenticated && inAuthGroup) {
    return <Redirect href="/" />;
  }

  // WEB: render <Slot/> so the matched route flows in normal document flow (the
  // BODY is the scroller). A native-stack <Stack> clamps each scene in a
  // viewport-height `position: absolute; inset: 0` container, leaving
  // `position: sticky` no taller scroll container to pin within.
  if (Platform.OS === 'web') {
    return <Slot />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
