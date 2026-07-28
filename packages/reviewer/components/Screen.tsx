/**
 * Page chrome shared by every reviewer screen.
 *
 * Nothing here is decorative: the same header, the same column width and the
 * same panel treatment on every screen is what lets the case viewer look like
 * part of the app without carrying any brand into the review itself (PLAN §9.1
 * hides the application's brand where it is not needed).
 */

import React from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PageScroll } from '@/components/PageScroll';

interface ScreenProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function Screen({ title, subtitle, children }: ScreenProps) {
  // Padding belongs on the inner View, never on SafeAreaView: the safe-area
  // component writes its own inline padding for the insets, which overrides any
  // padding utility on the same element (0 on web, so the utility vanishes).
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <PageScroll>
        <View className="mx-auto w-full max-w-[720px] gap-6">
          <View className="gap-2">
            <Text className="text-[26px] font-bold leading-8 text-foreground">{title}</Text>
            {subtitle ? (
              <Text className="text-base leading-6 text-muted-foreground">{subtitle}</Text>
            ) : null}
          </View>
          {children}
        </View>
      </PageScroll>
    </SafeAreaView>
  );
}

interface PanelProps {
  title?: string;
  description?: string;
  children?: React.ReactNode;
}

/** A bordered section. The one grouping primitive the app uses. */
export function Panel({ title, description, children }: PanelProps) {
  return (
    <View className="gap-3 rounded-lg border border-border bg-card p-4">
      {title ? (
        <Text className="text-lg font-semibold text-card-foreground">{title}</Text>
      ) : null}
      {description ? (
        <Text className="text-sm leading-5 text-muted-foreground">{description}</Text>
      ) : null}
      {children}
    </View>
  );
}
