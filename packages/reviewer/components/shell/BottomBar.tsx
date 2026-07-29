/**
 * The mobile navigation — Bloom's floating tab bar, carrying exactly the
 * destinations the rail carries.
 *
 * It is not a reduced version of the rail: all five surfaces are here, so
 * nothing is reachable at one width and hidden at another. The account is the
 * one thing it does not hold; that lives in the drawer, where `ProfileButton`
 * can give it the room an account switcher needs.
 */

import { useHaptics } from '@oxyhq/bloom/hooks';
import { TabBar, TabBarButton, useTabBarFootprint, type TabBarItem } from '@oxyhq/bloom/tab-bar';
import { usePathname, useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';

import { SHELL_DESTINATIONS } from '@/components/shell/navigation';

/**
 * Breathing margin (px) between the end of a screen's content and the top of the
 * pill, so the last line never sits flush against the bar.
 */
const BOTTOM_BAR_CLEARANCE = 12;

/**
 * Vertical space (px) a screen must leave free at its bottom for the floating
 * bar: Bloom's own footprint — the pill plus the gap it keeps from the window
 * edge, with the bottom safe-area inset ALREADY folded in — plus our clearance.
 *
 * Never add `insets.bottom` to the result. Bloom folds the inset into its own
 * gap, so adding it again counts the home indicator twice and strands a band of
 * dead space under every page.
 */
export function useBottomBarReservedSpace(): number {
  return useTabBarFootprint() + BOTTOM_BAR_CLEARANCE;
}

export function BottomBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const haptic = useHaptics();

  // A floating bar over an open keyboard is a bar over the field being typed
  // into. The hook is a no-op on web (the library ships a neutral binding
  // there), so this is simply always false in a browser.
  const keyboardVisible = useKeyboardState((state) => state.isVisible);

  // -1 on the case viewer, recusal and onboarding: they are not destinations, so
  // no tab is theirs. Bloom fades the highlight out rather than leaving it parked
  // on whichever tab happened to be last.
  const activeIndex = SHELL_DESTINATIONS.findIndex(
    (destination) => destination.href === pathname,
  );

  const items = useMemo<TabBarItem[]>(
    () =>
      SHELL_DESTINATIONS.map((destination) => {
        const Icon = destination.icon;
        return {
          name: destination.href,
          label: t(destination.labelKey),
          // No `fill` here on purpose: the bar injects the layer's tint as the
          // icon's fill, which is what makes the active/inactive crossfade work.
          icon: <Icon size="md" />,
        };
      }),
    [t],
  );

  const handleIndexChange = useCallback(
    (index: number) => {
      const destination = SHELL_DESTINATIONS[index];
      if (!destination) {
        return;
      }
      haptic('light');
      router.navigate(destination.href);
    },
    [haptic, router],
  );

  if (keyboardVisible) {
    return null;
  }

  // POSITIONING: Bloom pins its bar with `position: absolute` against this
  // wrapper. On NATIVE the wrapper is a zero-height flex item at the end of the
  // shell column, so the bar lands on the window's bottom edge. On WEB the app
  // scrolls the DOCUMENT, where `absolute` would resolve against the tall
  // document and scroll out of view — so the wrapper pins to the viewport and
  // the bar's own `absolute` resolves against that instead. The classes carry
  // the `web:` prefix, so the wrapper is inert on native.
  return (
    <View className="web:fixed web:inset-x-0 web:bottom-0 web:z-[1000]">
      <TabBar activeIndex={activeIndex} onIndexChange={handleIndexChange}>
        {items.map((item, index) => (
          <TabBarButton key={item.name} item={item} index={index} />
        ))}
      </TabBar>
    </View>
  );
}
