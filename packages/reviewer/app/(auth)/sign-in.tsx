import { useAuth } from '@oxyhq/services/ui/client';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OXY_CLIENT_ID } from '@/config';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('SignInScreen');

export default function SignInScreen() {
  const { signIn } = useAuth();
  const { t } = useTranslation();

  // `signIn()` opens the SDK's in-app account modal. It rejects when the person
  // dismisses it, which is not an error worth surfacing — but a real failure is.
  const handleSignIn = useCallback(() => {
    signIn().catch((error: unknown) => {
      logger.warn('Sign-in did not complete', { error });
    });
  }, [signIn]);

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
          <Pressable
            accessibilityRole="button"
            className="mt-4 w-full items-center rounded-full bg-primary px-6 py-4"
            onPress={handleSignIn}
          >
            <Text className="text-base font-semibold text-primary-foreground">
              {t('signIn.action')}
            </Text>
          </Pressable>
        ) : (
          // No hard-coded client id exists for CrowdSource yet, and inventing one
          // would borrow another product's identity. Say so rather than render a
          // button that cannot work.
          <Text className="mt-4 max-w-[300px] text-center text-sm text-muted-foreground">
            {t('signIn.unconfigured')}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}
