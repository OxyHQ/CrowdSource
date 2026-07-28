import { Link } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

export default function NotFoundScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 items-center justify-center gap-4 bg-background p-6">
      <Text className="text-xl font-bold text-foreground">{t('notFound.title')}</Text>
      <Link href="/" className="text-base font-semibold text-primary">
        {t('notFound.action')}
      </Link>
    </View>
  );
}
