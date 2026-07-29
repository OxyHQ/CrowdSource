/**
 * Page chrome shared by every reviewer screen.
 *
 * The composition is Mention's — `PanelStickyHeader` owning the panel inset,
 * the opaque surface and the rounded top corners, with `Header` inside it and
 * the screen supplying the auto-hide translate. This app has five surfaces
 * rather than thirty, so it composes that ONCE here instead of per screen;
 * everything the header itself does is Mention's file, unchanged.
 *
 * Nothing here is decorative: the same header, the same panel treatment and the
 * same motion on every screen is what lets the case viewer look like part of
 * the app without carrying any brand into the review itself (PLAN §9.1 hides
 * the application's brand where it is not needed).
 *
 * The header is the screen's title, its subtitle, and — on a phone — the only
 * way to the menu. It slides away under the finger as the page is scrolled and
 * comes back on the way up, in lock-step with the floating bar's minimize,
 * because both read the one signal in `BottomBarVisibilityContext`.
 */

import { Bars3_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import { IconButton } from '@oxyhq/bloom/button';
import React, { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import { useAnimatedStyle, useDerivedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Header } from '@/components/Header';
import { PageScroll } from '@/components/PageScroll';
import { SEO } from '@/components/SEO';
import {
  PANEL_HEADER_HEIGHT,
  PanelChromeTopInsetProvider,
  PanelStickyHeader,
} from '@/components/shell/PanelChrome';
import { useBottomBarHidden } from '@/context/BottomBarVisibilityContext';
import { useDrawer } from '@/context/DrawerContext';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

/** Rendered size (px) of the menu glyph, matching the bar's tab glyphs. */
const MENU_ICON_SIZE = 22;

interface ScreenProps {
  /**
   * The screen's name, in the header. Omitted on the one screen whose header
   * carries the mark instead — a title beside it would say the same thing twice.
   */
  title?: string;
  /**
   * The header's second line. A `ReactNode` rather than a string because the
   * home screen puts CrowdSource's mark in this slot, exactly as Mention's home
   * puts its own there.
   *
   * A SENTENCE does not belong here, which is why every screen that has one
   * opens with it as body copy instead: `Header` gives its right cluster
   * `flex: 1` whether or not anything is in it, so a left-aligned subtitle only
   * ever gets half the row and wraps. The chrome absorbs the resulting height
   * (it is measured, below) — this is about it looking wrong, not breaking.
   */
  subtitle?: ReactNode;
  /** `center` for the mark; the default `left` for a named screen. */
  titlePosition?: 'left' | 'center';
  /**
   * The browser tab's name, when it cannot be the header's. Only the home
   * screen needs it: its header carries the mark instead of a title, and a tab
   * reading only `CrowdSource` tells a reviewer with several tabs open nothing.
   */
  documentTitle?: string;
  children: ReactNode;
}

export function Screen({ title, subtitle, titlePosition, documentTitle, children }: ScreenProps) {
  // The rail carries navigation from 500px up, so the menu button is the phone's
  // only way to it — and only the phone's.
  const isScreenNotMobile = useIsScreenNotMobile();
  const insets = useSafeAreaInsets();

  // How far the header has to travel to be fully gone, and how much room the
  // page has to leave for it on native. MEASURED, not assumed:
  // `PANEL_HEADER_HEIGHT` is only the row's minimum, and the row grows past it
  // in ordinary conditions — the phone's 40px menu button takes it to 56, and a
  // title long enough to wrap takes it further still (`Header` gives its right
  // cluster `flex: 1` whether or not anything is in it, so a left-aligned title
  // only ever gets half the row). Both were observed in a browser: at 390px the
  // onboarding header measures 79. Translating by a constant instead leaves a
  // band of chrome parked over the page, and a title's length is a function of
  // the locale, so no constant could be right in all three.
  const [headerHeight, setHeaderHeight] = useState(PANEL_HEADER_HEIGHT);
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    // Rounded so sub-pixel jitter cannot churn state every frame; React bails
    // out of the re-render when the value is unchanged.
    setHeaderHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

  // The shared auto-hide signal (0 shown, 1 hidden). Derived from the same value
  // the floating bar minimizes on, so the two move together and neither runs its
  // own scroll listener.
  const hidden = useBottomBarHidden();
  const headerTranslateY = useDerivedValue(
    () => hidden.value * -(headerHeight + insets.top),
    [hidden, headerHeight, insets.top],
  );

  // Translate only. The header is an opaque surface that slides up behind the
  // status bar; fading it would let the scrolled page show through while it
  // rises, and the chrome has to read as one continuous surface — so there is no
  // opacity term here.
  //
  // The deps array is not optional. Reanimated only auto-tracks the shared
  // values a mapper reads when the worklets babel plugin has transformed it;
  // everywhere else the mapper re-runs on its deps, and one that omits its
  // driver runs once and freezes at the first frame while the value underneath
  // keeps animating. Listing it is a no-op where the plugin is present.
  const headerAnimatedStyle = useAnimatedStyle(
    () => ({ transform: [{ translateY: headerTranslateY.value }] }),
    [headerTranslateY],
  );

  return (
    <View className="flex-1">
      <SEO title={documentTitle ?? title} />

      <PanelStickyHeader level={0} style={headerAnimatedStyle}>
        {/*
         * The measuring element, and the reason it is a bare `View` with no
         * `className`: react-native-css never fires `onLayout` on web for a
         * component it has given classes to, and `PanelStickyHeader` is one. A
         * style-free wrapper inside it does fire, on both platforms.
         */}
        <View onLayout={handleHeaderLayout}>
          <Header
            options={{
              title,
              titlePosition,
              subtitle,
              leftComponents: isScreenNotMobile ? [] : [<MenuButton key="menu" />],
            }}
            // `hideBottomBorder` is NOT passed. Mention's home hides it because
            // its sticky tab bar supplies the edge underneath; these screens
            // have no second tier, and the content scrolls behind this header,
            // so the edge is the only thing separating the two.
            disableSticky
          />
        </View>
      </PanelStickyHeader>

      {/*
       * On native the header is an absolute overlay, so the page scrolls behind
       * it and reserves its height as a CONSTANT top inset — constant whether
       * the header is shown or hidden, so hiding it never reflows the content
       * being scrolled, which is the feedback an auto-hide loop feeds on. Web
       * ignores the value: there the header is sticky in normal flow.
       */}
      <PanelChromeTopInsetProvider value={headerHeight}>
        <PageScroll>
          {/*
           * Full width, and starting flush under the header. There was a
           * `max-w-[720px] mx-auto` column and a `pt-4` here; both were ours,
           * neither was Mention's. A second max-width inside a panel the shell
           * already caps at 950px just makes the panel look mis-centred at the
           * widths between the two, and Mention's content begins at the header's
           * edge rather than after a gap. The horizontal inset stays — it is the
           * section padding Mention puts on each row, not a column — so a
           * bordered `Panel` does not sit against the panel's rounded edge.
           */}
          <View className="w-full gap-6 px-4">{children}</View>
        </PageScroll>
      </PanelChromeTopInsetProvider>
    </View>
  );
}

function MenuButton() {
  const { t } = useTranslation();
  const { open } = useDrawer();

  return (
    <IconButton
      onPress={open}
      accessibilityLabel={t('shell.openMenu')}
      // Bloom's icon variant is the button: a 40px circle on the border token,
      // with its own hit slop, hover and pressed states. The glyph goes in
      // `icon` rather than as a child because the native fork wraps children in
      // a `<Text>`, which is no place for an SVG.
      icon={
        <Bars3_Stroke2_Corner0_Rounded
          width={MENU_ICON_SIZE}
          height={MENU_ICON_SIZE}
          fill="currentColor"
          className="text-foreground"
        />
      }
    />
  );
}

interface PanelProps {
  title?: string;
  description?: string;
  children?: ReactNode;
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
