/**
 * Page chrome shared by every reviewer screen.
 *
 * Nothing here is decorative: the same header, the same column width and the
 * same panel treatment on every screen is what lets the case viewer look like
 * part of the app without carrying any brand into the review itself (PLAN §9.1
 * hides the application's brand where it is not needed).
 *
 * The header is sticky on web, so the reviewer always knows which surface they
 * are on and, on a phone, always has the menu within reach — including halfway
 * down a long case. The screen's own title lives there rather than being
 * repeated as a heading below it.
 */

import { Bars3_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import { useTheme } from '@oxyhq/bloom/theme';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

import { useDrawer } from '@/context/DrawerContext';

import { Header } from '@/components/Header';
import { PageScroll } from '@/components/PageScroll';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

interface ScreenProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function Screen({ title, subtitle, children }: ScreenProps) {
  // The rail carries navigation from 500px up, so the menu button is the phone's
  // only way to it — and only the phone's.
  const isScreenNotMobile = useIsScreenNotMobile();

  return (
    <View className="flex-1">
      <PanelStickyHeader level={0}>
        <Header
          options={{
            title,
            leftComponents: isScreenNotMobile ? [] : [<MenuButton key="menu" />],
          }}
          disableSticky
        />
      </PanelStickyHeader>

      <PageScroll>
        <View className="mx-auto w-full max-w-[720px] gap-6">
          {subtitle ? (
            <Text className="text-base leading-6 text-muted-foreground">{subtitle}</Text>
          ) : null}
          {children}
        </View>
      </PageScroll>
    </View>
  );
}

function MenuButton() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { open } = useDrawer();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('shell.openMenu')}
      onPress={open}
      // Bare glyph with an 8px gutter, the same treatment `Header` gives its own
      // back button. The touch target is grown with `hitSlop`, which costs
      // nothing visually, rather than with a padded box that would show up as a
      // shape on the row.
      hitSlop={10}
      style={{ marginRight: 8 }}
    >
      {/* react-native-svg has no CSS cascade: the glyph takes its colour from its
          own `fill`, not from a `text-*` class on the wrapper. */}
      <Bars3_Stroke2_Corner0_Rounded size="lg" fill={colors.text} />
    </Pressable>
  );
}

interface PanelProps {
  title?: string;
  description?: string;
  children?: React.ReactNode;
}

/**
 * A bordered section. The one grouping primitive the app uses.
 *
 * No fill of its own: it sits on the panel's `bg-card` surface, and a card on a
 * card is a rectangle you can only find by its border anyway.
 */
export function Panel({ title, description, children }: PanelProps) {
  return (
    <View className="gap-3 rounded-lg border border-border p-4">
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
