/**
 * The signed-out surface.
 *
 * There is no sign-in form here and there never will be. `OxySignInButton` is
 * the SDK's own entry point: it resolves CrowdSource's registered Oxy
 * application by client id and routes accordingly — an official app opens the
 * in-app account dialog, a third-party one runs an OAuth + PKCE redirect. The
 * app does not choose between those, does not carry credentials, and does not
 * navigate to an identity provider itself.
 *
 * The root layout decides when this screen is shown. Nothing here navigates.
 */

import { OxySignInButton } from '@oxyhq/services/ui/client';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OXY_AUTH_REDIRECT_URI, OXY_CLIENT_ID } from '@/config';

export default function SignInScreen() {
  const { t } = useTranslation();

  // Padding belongs on the inner View, never on SafeAreaView: the safe-area
  // component writes its own inline padding for the insets, which overrides any
  // padding utility on the same element (0 on web, so the utility vanishes).
  return (
    <SafeAreaView className="flex-1 items-center justify-center bg-background">
      {/* No brand mark: CrowdSource has none yet, and the Oxy mark is Oxy's. */}
      <View className="w-full max-w-[360px] items-center gap-4 p-6">
        <Text className="text-[28px] font-bold text-foreground">{t('app.name')}</Text>
        <Text className="max-w-[300px] text-center text-base leading-[22px] text-muted-foreground">
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
          // device sign-in it would open identifies the requesting app by that
          // id. Inventing one would borrow another product's identity, so the
          // screen says what is missing instead of offering a button that
          // silently does nothing.
          <Text className="mt-4 max-w-[300px] text-center text-sm text-muted-foreground">
            {t('signIn.unconfigured')}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}
