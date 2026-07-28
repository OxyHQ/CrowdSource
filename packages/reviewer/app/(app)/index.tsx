import { getNormalizedUserHandle } from '@oxyhq/core';
import { useAuth } from '@oxyhq/services/ui/client';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  const { user } = useAuth();
  const { t } = useTranslation();

  // Oxy owns identity: render `displayName` directly and fall back to the
  // normalized handle when a profile has none. Never recompose a name locally.
  const displayName = user?.name?.displayName?.trim() || getNormalizedUserHandle(user) || '';

  // Padding belongs on the inner View, never on SafeAreaView: the safe-area
  // component writes its own inline padding for the insets, which overrides any
  // padding utility on the same element (0 on web, so the utility vanishes).
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="gap-3 p-6">
        <Text className="text-2xl font-bold text-foreground">{t('app.name')}</Text>
        {displayName ? (
          <Text className="text-base text-muted-foreground">
            {t('home.signedInAs', { name: displayName })}
          </Text>
        ) : null}
        <Text className="max-w-[520px] text-base leading-6 text-muted-foreground">
          {t('home.noAssignments')}
        </Text>
      </View>
    </SafeAreaView>
  );
}
