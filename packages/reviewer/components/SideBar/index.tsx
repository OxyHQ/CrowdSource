import React, { useCallback, useMemo } from "react";
import {
    Dimensions,
    Platform,
    View,
    StyleSheet,
} from "react-native";
import { usePathname, useRouter, type Href } from "expo-router";
import { useIsScreenNotMobile, useIsSideBarExpanded } from "@/hooks/useOptimizedMediaQuery";
import { useTranslation } from "react-i18next";
import { SideBarItem } from "./SideBarItem";

import {
    Beaker_Stroke2_Corner2_Rounded,
    Clock_Stroke2_Corner0_Rounded,
    Growth_Stroke2_Corner0_Rounded,
    Heart2_Stroke2_Corner0_Rounded,
    Home_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import { ProfileButton } from '@oxyhq/services';
import { useAuth } from '@oxyhq/services/ui/client';
import { asViewStyle, type WebViewStyle } from '@/types/webStyles';

const WindowHeight = Dimensions.get('window').height;

// Under document-scroll on web the shell row is a tall flex container. A flex
// child defaults to `align-items: stretch`, which would stretch this column to
// the row's full (scrollable) height — leaving the sticky box nowhere to move,
// so it scrolls away with the document. `alignSelf: 'flex-start'` constrains the
// box to its own `100vh` height, sitting at the top of the tall row, so
// `position: sticky; top: 0` pins it while only the center feed scrolls.
const webStickyContainerStyle: WebViewStyle = {
    position: 'sticky',
    alignSelf: 'flex-start',
    overflow: 'hidden',
    height: '100vh',
};

interface SideBarProps {
    asDrawer?: boolean;
    onNavigate?: () => void;
}

export function SideBar({ asDrawer = false, onNavigate }: SideBarProps) {
    const { t } = useTranslation();
    const router = useRouter();
    const { signIn } = useAuth();

    // Every sidebar destination is a TAB ROOT (review, training, history,
    // reliability, wellbeing). With the (app) center now a Stack, `navigate`
    // pops to an existing instance of the target instead of stacking a new copy,
    // so repeatedly clicking tabs never grows the stack or duplicates Home.
    const handleNavPress = useCallback((route: Href) => {
        onNavigate?.();
        router.navigate(route);
    }, [onNavigate, router]);

    // Adding another account (from the ProfileButton menu) and signing in while
    // signed out both go through the same SDK sign-in flow.
    const handleAddAccount = useCallback(() => {
        onNavigate?.();
        signIn().catch(() => {});
    }, [onNavigate, signIn]);

    // The five reviewer surfaces, and only those. `/review` and `/recuse` are
    // deliberately absent: a case exists only once the server has assigned one,
    // and a permanent entry for either would read as somewhere you can go and
    // look for one.
    //
    // `fill="currentColor"` is what lets `SideBarItem` tint these — it hands the
    // icon its color through the wrapper's `text-*` class on web and through the
    // cloned `color` prop on native. Both fields point at the same glyph because
    // Bloom has no filled twin for three of the five, and a set where two
    // destinations swap shape on selection and three do not reads as a mistake;
    // the pill and the tint carry the state instead.
    const sideBarData = useMemo<{ title: string; icon: React.ReactNode; iconActive: React.ReactNode; route?: Href; onPress?: () => void }[]>(() => [
        {
            title: t("sidebar.home"),
            icon: <Home_Stroke2_Corner0_Rounded width={26} height={26} fill="currentColor" />,
            iconActive: <Home_Stroke2_Corner0_Rounded width={26} height={26} fill="currentColor" />,
            route: '/',
        },
        {
            title: t("sidebar.training"),
            icon: <Beaker_Stroke2_Corner2_Rounded width={26} height={26} fill="currentColor" />,
            iconActive: <Beaker_Stroke2_Corner2_Rounded width={26} height={26} fill="currentColor" />,
            route: '/training',
        },
        {
            title: t("sidebar.history"),
            icon: <Clock_Stroke2_Corner0_Rounded width={26} height={26} fill="currentColor" />,
            iconActive: <Clock_Stroke2_Corner0_Rounded width={26} height={26} fill="currentColor" />,
            route: '/history',
        },
        {
            title: t("sidebar.reliability"),
            icon: <Growth_Stroke2_Corner0_Rounded width={26} height={26} fill="currentColor" />,
            iconActive: <Growth_Stroke2_Corner0_Rounded width={26} height={26} fill="currentColor" />,
            route: '/reliability',
        },
        {
            title: t("sidebar.wellbeing"),
            icon: <Heart2_Stroke2_Corner0_Rounded width={26} height={26} fill="currentColor" />,
            iconActive: <Heart2_Stroke2_Corner0_Rounded width={26} height={26} fill="currentColor" />,
            route: '/wellbeing',
        },
    ], [t]);

    const pathname = usePathname();
    const isSideBarVisible = useIsScreenNotMobile();
    const isExpanded = useIsSideBarExpanded();

    if (!asDrawer && !isSideBarVisible) return null;

    const showExpanded = asDrawer || isExpanded;

    return (
        <View
            className="bg-background"
            style={[
                asDrawer ? styles.drawerContainer : styles.container,
                !asDrawer && { width: showExpanded ? 240 : 60 },
            ]}
        >
            <View style={styles.inner}>
                <View style={[
                    styles.navigationSection,
                    { alignItems: showExpanded ? 'flex-start' : 'center' },
                ]}>
                    {sideBarData.map(({ title, icon, iconActive, route, onPress }) => (
                        <SideBarItem
                            href={asDrawer ? undefined : route}
                            key={title}
                            icon={pathname === route ? iconActive : icon}
                            text={title}
                            isActive={pathname === route}
                            isExpanded={showExpanded}
                            onPress={onPress || (asDrawer && route ? () => handleNavPress(route) : undefined)}
                        />
                    ))}
                </View>

                <View style={[
                    styles.footer,
                    { alignItems: showExpanded ? 'flex-start' : 'center' },
                ]}>
                    {/* Account trigger. ProfileButton owns all three auth states
                        (undetermined skeleton, signed-in row + account switcher,
                        signed-out "Sign in") and the device-account switcher menu
                        (switch / add account / sign out / sign out all). */}
                    <ProfileButton
                        expanded={showExpanded}
                        onAddAccount={handleAddAccount}
                    />
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        padding: 6,
        ...(Platform.OS === 'web'
            ? asViewStyle(webStickyContainerStyle)
            : { height: WindowHeight }),
        top: 0,
        zIndex: 1000,
    },
    drawerContainer: {
        flex: 1,
        width: 280,
        padding: 12,
    },
    inner: {
        flex: 1,
        width: '100%',
        justifyContent: 'flex-start',
        alignItems: 'center',
    },
    navigationSection: {
        flex: 1,
        justifyContent: 'center',
        width: '100%',
        gap: 2,
    },
    footer: {
        flexDirection: 'column',
        justifyContent: 'flex-end',
        width: '100%',
        marginTop: 'auto',
    },
});
