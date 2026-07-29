/**
 * AppProviders
 *
 * The single place the app's provider tree is composed. Memoized so a root
 * re-render never remounts the providers underneath it.
 */

import { OxyServices } from '@oxyhq/core';
import { OxyProvider } from '@oxyhq/services/ui/client';
import { QueryClient } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import React, { memo, useCallback } from 'react';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { ReviewerIdentityBoundary } from '@/components/providers/ReviewerIdentityBoundary';
import { OXY_AUTH_REDIRECT_URI, OXY_CLIENT_ID } from '@/config';
import i18n from '@/lib/i18n';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('AppProviders');

interface AppProvidersProps {
  children: React.ReactNode;
  oxyServices: OxyServices;
  queryClient: QueryClient;
}

export const AppProviders = memo(function AppProviders({
  children,
  oxyServices,
  queryClient,
}: AppProvidersProps) {
  const handleBoundaryError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
    logger.error('Error caught by boundary', { error, errorInfo });
  }, []);

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/*
         * react-native-keyboard-controller's root provider. It MUST sit inside
         * GestureHandlerRootView and above everything that consumes
         * KeyboardContext — OxyProvider's sheets and Bloom's BottomSheet — or
         * those hooks log "Couldn't find real values for KeyboardContext" on
         * native. It is a passthrough no-op on web (the library handles the
         * platform split internally; no manual .web fork needed).
         */}
        <KeyboardProvider>
          {/*
           * ONE SDK provider owns the session on web and native alike: the
           * device-first cold boot, account switching and the in-app sign-in
           * modal all live here. The app adds no auth routes, token providers or
           * Authorization headers of its own.
           */}
          <OxyProvider
            oxyServices={oxyServices}
            clientId={OXY_CLIENT_ID}
            authRedirectUri={OXY_AUTH_REDIRECT_URI}
            // Without this the web flow is a full-page redirect, and the app
            // bounces to the authorize endpoint before it ever renders. The
            // popup keeps the reviewer on their own page.
            webAuthMode="popup"
            storageKeyPrefix="crowdsource"
            queryClient={queryClient}
          >
            {/*
             * Inside OxyProvider because it reads the SDK's auth state and the
             * QueryClient the provider publishes; above everything else because
             * a switch of account has to reach every consumer at once.
             */}
            <ReviewerIdentityBoundary>
              <I18nextProvider i18n={i18n}>
                <AppErrorBoundary onError={handleBoundaryError}>
                  {children}
                  <StatusBar style="auto" />
                  {/*
                   * No <ToastOutlet /> here on purpose. Bloom's toast stack must
                   * be mounted exactly once — every mount subscribes to the same
                   * store and renders the same rows, so a second outlet shows
                   * every toast twice. OxyProvider above already mounts one, and
                   * it carries Bloom's defaults.
                   */}
                </AppErrorBoundary>
              </I18nextProvider>
            </ReviewerIdentityBoundary>
          </OxyProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
