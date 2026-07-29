/**
 * The application shell: rail, panel, right rail, and the floating bar the phone
 * gets instead of the first two.
 *
 * The geometry is Mention's, because it is the geometry every Oxy app shares —
 * a centred column that never grows past 950px, a rounded content panel floating
 * in an 8px gutter, and side rails that appear as the window earns them. What is
 * NOT Mention's is anything the panel holds: this app has no feed, no composer
 * and no realtime bridges, so none of that came across.
 *
 * WEB puts the routed content in a `<Slot/>` so it flows in document scroll (the
 * body is the scroller, which is what makes `position: sticky` work at all).
 * NATIVE keeps a `<Stack>` for real push/pop, so the case viewer pushes over the
 * screen that asked for it and `back` returns to it with its scroll intact.
 */

import { ContentPanel } from '@oxyhq/bloom/content-panel';
import { Slot, Stack } from 'expo-router';
import React from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomBar, useBottomBarReservedSpace } from '@/components/BottomBar';
import { DrawerOverlay } from '@/components/DrawerOverlay';
import { RightBar } from '@/components/RightBar';
import { SideBar } from '@/components/SideBar';
import { BottomBarVisibilityProvider } from '@/context/BottomBarVisibilityContext';
import { DrawerProvider } from '@/context/DrawerContext';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { cn } from '@/lib/utils';

const IS_WEB = Platform.OS === 'web';

export default function AppLayout() {
  const isScreenNotMobile = useIsScreenNotMobile();
  const reservedSpace = useBottomBarReservedSpace();

  // Mobile web: the bar is `position: fixed`, so it takes no document-scroll
  // space and the last line of every page would slide under it. Reserving its
  // footprint here — once, for every route — is what stops that. The value
  // already folds in the bottom safe-area inset; nothing may be added to it.
  // 0 on desktop, and 0 on native, where the scroller pads itself instead.
  const bottomInset = IS_WEB && !isScreenNotMobile ? reservedSpace : 0;

  return (
    <DrawerProvider>
      {/*
       * One driver for every piece of chrome that reacts to scrolling: the
       * screen headers translate off it and the floating bar minimizes off it,
       * from a single integration of the scroll position. Scoped to this group
       * because the signed-out surface has no chrome to hide.
       */}
      <BottomBarVisibilityProvider>
        {/*
         * The shell owns the top safe area, once, so no screen has to. Only the
         * top: the bottom belongs to the floating bar, which folds the inset
         * into its own gap — claiming it here as well would count the home
         * indicator twice. On web every inset is 0 and this is a plain row.
         *
         * Padding utilities must not go on this element: the safe-area
         * component writes its own inline padding for the insets and would
         * override them.
         */}
        <SafeAreaView
          edges={['top']}
          className={cn(
            'w-full flex-1 bg-background',
            isScreenNotMobile ? 'flex-row justify-center' : 'flex-col',
          )}
        >
          <SideBar />
          {/* Panel plus right rail, never wider than 950px however wide the
              window gets — the rail stays where the eye expects it instead of
              drifting towards the far edge of a 4K display. */}
          <View
            className={cn(
              'flex-1 justify-between bg-background',
              isScreenNotMobile ? 'max-w-[950px] shrink flex-row' : 'flex-col',
            )}
          >
            {/* The gutter: the `bg-background` band around the floating panel.
                `pl-0` so the panel meets the rail flush on the side it shares
                with it. Gated on the same breakpoint as the rail — once the rail
                is gone the panel is full-bleed and there is no gutter to
                paint. */}
            <View
              className={cn('bg-background', IS_WEB && isScreenNotMobile && 'p-2 pl-0')}
              style={{ flex: isScreenNotMobile ? 2.2 : 1 }}
            >
              <ContentPanel framedFrom={500} contentStyle={{ paddingBottom: bottomInset }}>
                {IS_WEB ? (
                  <Slot />
                ) : (
                  <Stack
                    screenOptions={{
                      headerShown: false,
                      animation: 'default',
                      freezeOnBlur: true,
                      contentStyle: { flex: 1, backgroundColor: 'transparent' },
                    }}
                  />
                )}
              </ContentPanel>
            </View>
            <RightBar />
          </View>
        </SafeAreaView>
        {isScreenNotMobile ? null : <BottomBar />}
        {isScreenNotMobile ? null : <DrawerOverlay />}
      </BottomBarVisibilityProvider>
    </DrawerProvider>
  );
}
