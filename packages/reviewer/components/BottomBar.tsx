import { View } from 'react-native';
import {
    Beaker_Stroke2_Corner2_Rounded,
    Clock_Stroke2_Corner0_Rounded,
    Growth_Stroke2_Corner0_Rounded,
    Heart2_Stroke2_Corner0_Rounded,
    Home_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import { useRouter, usePathname } from 'expo-router';
import React, { useCallback, useMemo } from 'react';

import { useHaptics } from '@oxyhq/bloom/hooks';
import {
    TabBar,
    TabBarButton,
    useTabBarFootprint,
    type TabBarItem,
} from '@oxyhq/bloom/tab-bar';
import { useTranslation } from 'react-i18next';

/** Rendered size (px) of the tab glyphs; Bloom centers each one in its own glyph box. */
const ICON_SIZE = 22;

/** Tab order. Shared by the pathname → index derivation and the press handlers. */
const TAB_HOME = 0;
const TAB_TRAINING = 1;
const TAB_HISTORY = 2;
const TAB_RELIABILITY = 3;
const TAB_WELLBEING = 4;

/**
 * Breathing margin (px) between the end of a screen's scrollable content and the
 * top of the pill, so the last row never sits flush against the bar.
 */
const BOTTOM_BAR_CLEARANCE = 12;

/**
 * Vertical space (px) a scrollable screen must leave free at its bottom for the
 * floating bar: Bloom's own footprint — the expanded pill plus the gap it keeps
 * from the window edge, with the bottom safe-area inset ALREADY folded in — plus
 * Mention's clearance.
 *
 * A hook rather than a constant because the footprint depends on the safe-area
 * inset. Never add `insets.bottom` to the result: Bloom folds the inset into its
 * own bottom gap, so adding it again counts the home indicator twice and strands a
 * band of dead space under every list.
 */
export function useBottomBarReservedSpace(): number {
    return useTabBarFootprint() + BOTTOM_BAR_CLEARANCE;
}

export const BottomBar = () => {
    const router = useRouter();
    const pathname = usePathname();
    const haptic = useHaptics();
    const { t } = useTranslation();

    // The glyphs need their own copy of the tint decision because the theme
    // cannot reach them: Bloom tints a glyph by CLONING it with a `fill` prop,
    // and these are handed `fill="currentColor"` so they paint from their
    // className instead (react-native-svg's `color` prop on native, the CSS
    // cascade on web). `activeTint`/`inactiveTint` are therefore a silent no-op
    // on them and the className is the only channel that works.
    const activeGlyphClass = 'text-primary';
    const inactiveGlyphClass = 'text-muted-foreground';

    // -1 on the case viewer, recusal and onboarding: they are not destinations,
    // so no tab is theirs. Bloom fades the highlight out rather than leaving it
    // parked on whichever tab happened to be last.
    const activeIndex = pathname === '/' ? TAB_HOME
        : pathname === '/training' ? TAB_TRAINING
        : pathname === '/history' ? TAB_HISTORY
        : pathname === '/reliability' ? TAB_RELIABILITY
        : pathname === '/wellbeing' ? TAB_WELLBEING
        : -1;

    const items = useMemo<TabBarItem[]>(() => [
        {
            name: 'home',
            label: t('bottomBar.home'),
            icon: <Home_Stroke2_Corner0_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={inactiveGlyphClass} />,
            activeIcon: <Home_Stroke2_Corner0_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={activeGlyphClass} />,
        },
        {
            name: 'training',
            label: t('bottomBar.training'),
            icon: <Beaker_Stroke2_Corner2_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={inactiveGlyphClass} />,
            activeIcon: <Beaker_Stroke2_Corner2_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={activeGlyphClass} />,
        },
        {
            name: 'history',
            label: t('bottomBar.history'),
            icon: <Clock_Stroke2_Corner0_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={inactiveGlyphClass} />,
            activeIcon: <Clock_Stroke2_Corner0_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={activeGlyphClass} />,
        },
        {
            name: 'reliability',
            label: t('bottomBar.reliability'),
            icon: <Growth_Stroke2_Corner0_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={inactiveGlyphClass} />,
            activeIcon: <Growth_Stroke2_Corner0_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={activeGlyphClass} />,
        },
        {
            name: 'wellbeing',
            label: t('bottomBar.wellbeing'),
            icon: <Heart2_Stroke2_Corner0_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={inactiveGlyphClass} />,
            activeIcon: <Heart2_Stroke2_Corner0_Rounded width={ICON_SIZE} height={ICON_SIZE} fill="currentColor" className={activeGlyphClass} />,
        },
    ], [activeGlyphClass, inactiveGlyphClass, t]);

    const handleIndexChange = useCallback((index: number) => {
        haptic('light');
        switch (index) {
            case TAB_HOME:
                router.navigate('/');
                break;
            case TAB_TRAINING:
                router.navigate('/training');
                break;
            case TAB_HISTORY:
                router.navigate('/history');
                break;
            case TAB_RELIABILITY:
                router.navigate('/reliability');
                break;
            case TAB_WELLBEING:
                router.navigate('/wellbeing');
                break;
        }
    }, [haptic, router]);

    // POSITIONING: Bloom's bar pins itself with `position: absolute` against this
    // wrapper. On NATIVE the wrapper is a zero-height flex item at the end of the
    // shell column, so the bar lands on the window's bottom edge. On WEB the app
    // uses a DOCUMENT-scroll model (the window is the scroller), where `absolute`
    // would resolve against the tall document and scroll out of view — so the
    // wrapper pins to the viewport with `web:fixed web:inset-x-0 web:bottom-0` and
    // the bar's own `absolute` resolves against that instead. The classes carry the
    // `web:` prefix, so the wrapper is inert on native.
    return (
        <View className="web:fixed web:inset-x-0 web:bottom-0 web:z-[1000]">
            {/* Bloom paints a progressive blur across the bottom 114px of the window
                (120px in an iOS PWA) behind the pill. That band is what dissolves
                scrolling content behind the bar, so it stays on. There is no
                consumer-side fix for the smear it would cause over full-bleed
                media, on either platform: the bar host is the LAST sibling of the
                shell, so no `zIndex` on a shell descendant can paint above it. Do
                not fight this with z-index; `blur` is the control. */}
            <TabBar
                activeIndex={activeIndex}
                onIndexChange={handleIndexChange}
            >
                {items.map((item, index) => (
                    <TabBarButton key={item.name} item={item} index={index} />
                ))}
            </TabBar>
        </View>
    );
};
