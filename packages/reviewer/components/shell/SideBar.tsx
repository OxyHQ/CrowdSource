/**
 * The left rail — the shell's primary navigation from 500px up, and the body of
 * the mobile drawer below it.
 *
 * Three widths, one component: icons only at 500px, labelled rows at 1300px, and
 * the same labelled rows inside the drawer at any width. What it does NOT have
 * is the thing a social app puts here: there is no compose button, and no
 * prominent "get me a case" shortcut either. Asking for a case depends on
 * consent, calibration state and how much the reviewer has already seen today,
 * all of which Home shows in the same breath as the button. A shortcut in the
 * chrome would either duplicate that reasoning or, worse, offer the action
 * without it.
 */

import { ShieldCheck_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { ProfileButton } from '@oxyhq/services';
import { usePathname } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { SHELL_DESTINATIONS } from '@/components/shell/navigation';
import { SideBarItem } from '@/components/shell/SideBarItem';
import { useIsScreenNotMobile, useIsSideBarExpanded } from '@/lib/responsive';
import { cn } from '@/lib/utils';

interface SideBarProps {
  /** Rendered as the drawer's contents: always expanded, never self-hiding. */
  asDrawer?: boolean;
  /** Called when a destination is chosen — the drawer closes itself this way. */
  onNavigate?: () => void;
}

export function SideBar({ asDrawer = false, onNavigate }: SideBarProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const pathname = usePathname();
  const isRailVisible = useIsScreenNotMobile();
  const isExpanded = useIsSideBarExpanded();

  if (!asDrawer && !isRailVisible) {
    return null;
  }

  const showExpanded = asDrawer || isExpanded;

  return (
    <View
      className={cn(
        'bg-background',
        asDrawer
          ? 'w-[280px] flex-1 p-3'
          : cn(
              'p-1.5',
              // Web scrolls the DOCUMENT, so the rail pins with `sticky` and must
              // be kept from stretching to the tall shell row's height —
              // `self-start` gives the sticky box its own viewport-height box to
              // move within. Native has no document scroll: the rail is just a
              // full-height flex child.
              'web:sticky web:top-0 web:h-screen web:self-start web:overflow-hidden',
              showExpanded ? 'w-[240px]' : 'w-[60px]',
            ),
      )}
    >
      {/*
       * The rail's head: a plain glyph and the app's name. Not a logo — the
       * sign-in screen already settled that CrowdSource has no mark of its own
       * yet and that the Oxy mark is Oxy's. A shield is what a 60px rail needs so
       * the collapsed column does not start with an empty band.
       */}
      <View
        className={cn(
          'flex-row items-center gap-2 px-3 py-4',
          showExpanded ? 'justify-start' : 'justify-center',
        )}
      >
        <ShieldCheck_Stroke2_Corner0_Rounded size="lg" fill={colors.primary} />
        {showExpanded ? (
          <Text className="text-[17px] font-bold text-foreground" numberOfLines={1}>
            {t('app.name')}
          </Text>
        ) : null}
      </View>

      {/*
       * Top-aligned, not centred. Mention centres its rail because eleven
       * destinations fill it; five would float in the middle of a 900px column
       * with the brand marooned above them.
       */}
      <View
        className={cn(
          'w-full flex-1 justify-start gap-0.5 pt-2',
          showExpanded ? 'items-start' : 'items-center',
        )}
      >
        {SHELL_DESTINATIONS.map((destination) => (
          <SideBarItem
            key={destination.href}
            destination={destination}
            label={t(destination.labelKey)}
            isActive={pathname === destination.href}
            isExpanded={showExpanded}
            onNavigate={onNavigate}
          />
        ))}
      </View>

      {/*
       * The account, and the only door to it. `ProfileButton` owns all three
       * auth states — the undetermined skeleton during cold boot, the signed-in
       * row, the signed-out prompt — and opens the SDK's account dialog, where
       * switching account and signing out live. This app writes no sign-out code
       * of its own: the session belongs to `OxyProvider`, and a second way to end
       * it would be a second authority over it.
       */}
      <View className={cn('mt-auto w-full', showExpanded ? 'items-start' : 'items-center')}>
        <ProfileButton expanded={showExpanded} />
      </View>
    </View>
  );
}
