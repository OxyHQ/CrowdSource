/**
 * The console shell: the rail, and the panel the routed screen renders into.
 *
 * The geometry is the Oxy shell every app in the ecosystem shares — a rounded
 * content panel floating in an 8px gutter, with the rail beside it — with ONE
 * deliberate divergence: the centred column is capped at 1440px rather than the
 * 950px a feed uses. A delivery table is eight columns wide and a case detail is a
 * two-column key/value block; capping this surface at feed width would leave a
 * table scrolling sideways on a display that had room for it.
 *
 * `<Slot/>` rather than a `<Stack>`: the routed content flows in document scroll,
 * which is what makes the body the scroller and therefore what makes the rail, the
 * screen header and the toolbar sticky. See `global.css`.
 *
 * There is no bottom bar and no drawer. Below the rail's breakpoint the rail stacks
 * above the content as a full-width block (see `components/SideBar`), so navigation
 * is always visible and never behind a tap.
 */

import { ContentPanel } from '@oxyhq/bloom/content-panel';
import { Slot } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { SideBar } from '@/components/SideBar';
import { useIsRailFixed, useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { cn } from '@/lib/utils';

export default function ConsoleLayout() {
  const isRailFixed = useIsRailFixed();
  const isFramed = useIsScreenNotMobile();

  return (
    <View
      className={cn('w-full flex-1 bg-background', isRailFixed ? 'flex-row justify-center' : 'flex-col')}
    >
      <SideBar />
      {/* The panel, never wider than 1440px however wide the window gets, so a
          table's columns stay within one eye movement of each other instead of
          drifting to the far edge of a 4K display. */}
      <View className={cn('flex-1 bg-background', isRailFixed && 'max-w-[1440px] shrink')}>
        {/* The gutter: the `bg-background` band around the floating panel. `pl-0`
            so the panel meets the rail flush on the side it shares with it. Gated on
            the same breakpoint as the frame — once the panel is full-bleed there is
            no gutter to paint. */}
        <View className={cn('flex-1 bg-background', isFramed && 'p-2', isRailFixed && 'pl-0')}>
          <ContentPanel framedFrom={500}>
            <Slot />
          </ContentPanel>
        </View>
      </View>
    </View>
  );
}
