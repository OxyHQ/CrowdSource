/**
 * The signed-out surface.
 *
 * There is no sign-in form here and there never will be. `OxySignInButton` is the
 * SDK's own entry point: it resolves CrowdSource's registered Oxy application by
 * client id and routes accordingly — an official app opens the in-app account
 * dialog, a third-party one runs an OAuth + PKCE redirect. The app does not choose
 * between those, does not carry credentials, and does not navigate to an identity
 * provider itself.
 *
 * The root layout decides when this screen is shown. Nothing here navigates.
 */

import { OxySignInButton } from '@oxyhq/services/ui/client';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { LogoIcon } from '@/components/LogoIcon';
import { SEO } from '@/components/SEO';
import { OXY_AUTH_REDIRECT_URI, OXY_CLIENT_ID } from '@/config';

export default function SignInScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <SEO title={t('signIn.title')} />
      <View className="w-full max-w-[380px] items-center gap-4 p-6">
        {/* CrowdSource's own mark, not Oxy's — the Oxy mark belongs to the sign-in
            button below, which is the SDK's surface and says whose identity is
            being used. */}
        <LogoIcon height={48} />
        <Text className="text-2xl font-bold text-foreground">{t('app.name')}</Text>
        <Text className="max-w-[320px] text-center text-sm leading-5 text-muted-foreground">
          {t('signIn.tagline')}
        </Text>

        {OXY_CLIENT_ID ? (
          <View className="mt-4 w-full">
            <OxySignInButton
              variant="contained"
              text={t('signIn.action')}
              oauthRedirectUri={OXY_AUTH_REDIRECT_URI}
            />
          </View>
        ) : (
          // Without a registered client id the SDK cannot start EITHER flow: the
          // device sign-in it would open identifies the requesting app by that id.
          // Inventing one would borrow another product's identity, so the screen
          // says what is missing instead of offering a button that silently does
          // nothing.
          <Text className="mt-4 max-w-[320px] text-center text-sm text-muted-foreground">
            {t('signIn.unconfigured')}
          </Text>
        )}

        {/* Said here rather than after the 403: an operator who signs in expecting
            the Trust & Safety views and finds only their own tenants should know
            why. The roles are granted outside this service and no route in it
            hands one out. */}
        <Text className="mt-2 max-w-[320px] text-center text-xs leading-4 text-muted-foreground">
          {t('signIn.audiences')}
        </Text>
      </View>
    </View>
  );
}
