/**
 * The mobile drawer: the rail, widened, plus the account.
 *
 * Below 500px the rail is gone and the floating bar carries the five surfaces as
 * glyphs. This is where their names are, and where `ProfileButton` gets the room
 * an account switcher needs — the bar has five cells and no sixth to spare.
 *
 * The slide is driven IMPERATIVELY: `open`/`close` write the shared value from
 * the event handler that caused the change, and `useAnimatedStyle` only reads
 * it. Returning an animation from a mapper silently never ticks on web, and
 * driving it from an effect would mean an effect for something an event already
 * knows. The shared value is listed in each mapper's dependency array so the
 * styles keep tracking it even in a bundle without the worklets plugin.
 *
 * It stays mounted after the first open — a drawer that unmounts on close has to
 * choose between cutting its own exit animation short and holding a timer to
 * decide when it is safe to go. `pointerEvents` is what makes a closed drawer
 * harmless; opacity would not be, since a fully transparent backdrop still
 * swallows every tap.
 */

import React, { createContext, memo, useCallback, useContext, useMemo, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

import { SideBar } from '@/components/shell/SideBar';

const IS_WEB = Platform.OS === 'web';

/** Panel width (px). The drawer's own width, matched by `SideBar asDrawer`. */
const DRAWER_WIDTH = 280;

const DRAWER_TIMING = { duration: 200 };

/**
 * Web scrolls the DOCUMENT, so an `absolute` overlay would resolve against the
 * tall document and sink below the fold; it pins to the viewport instead. Both
 * strings are literal so the class scan resolves them verbatim.
 */
const OVERLAY_CLASS = IS_WEB
  ? 'web:fixed web:inset-0 web:z-[2000]'
  : 'absolute inset-0 z-[2000]';

/**
 * `web:fixed` has to sit on the SAME element that carries the transform: a
 * transformed ancestor becomes the containing block of a fixed descendant and
 * re-traps it in the scrolled document.
 */
const PANEL_CLASS = IS_WEB
  ? 'web:fixed web:bottom-0 web:left-0 web:top-0 web:z-[2001] web:w-[280px]'
  : 'absolute bottom-0 left-0 top-0 z-[2001] w-[280px]';

interface DrawerControls {
  isOpen: boolean;
  /** True once the drawer has been opened at least once — see the note above. */
  hasOpened: boolean;
  /** 0 closed, 1 open. Read only from worklets. */
  progress: SharedValue<number>;
  open: () => void;
  close: () => void;
}

const DrawerContext = createContext<DrawerControls | null>(null);

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const progress = useSharedValue(0);
  const [state, setState] = useState({ isOpen: false, hasOpened: false });

  const open = useCallback(() => {
    setState({ isOpen: true, hasOpened: true });
    progress.value = withTiming(1, DRAWER_TIMING);
  }, [progress]);

  const close = useCallback(() => {
    setState((previous) => ({ ...previous, isOpen: false }));
    progress.value = withTiming(0, DRAWER_TIMING);
  }, [progress]);

  const controls = useMemo<DrawerControls>(
    () => ({ isOpen: state.isOpen, hasOpened: state.hasOpened, progress, open, close }),
    [state.isOpen, state.hasOpened, progress, open, close],
  );

  return <DrawerContext.Provider value={controls}>{children}</DrawerContext.Provider>;
}

export function useDrawer(): DrawerControls {
  const controls = useContext(DrawerContext);
  if (!controls) {
    throw new Error('useDrawer must be used inside <DrawerProvider>');
  }
  return controls;
}

export const DrawerOverlay = memo(function DrawerOverlay() {
  const { t } = useTranslation();
  const { isOpen, hasOpened, progress, close } = useDrawer();

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }), [progress]);
  const panelStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: interpolate(progress.value, [0, 1], [-DRAWER_WIDTH, 0]) }] }),
    [progress],
  );

  if (!hasOpened) {
    return null;
  }

  return (
    <View className={OVERLAY_CLASS} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('shell.closeMenu')}
        onPress={close}
        pointerEvents={isOpen ? 'auto' : 'none'}
        className="absolute inset-0"
      >
        <Animated.View className="flex-1 bg-black/40" style={scrimStyle} />
      </Pressable>
      {/*
       * A closed drawer is parked off-screen, not unmounted, so it has to be
       * taken out of the accessibility tree as well: otherwise a keyboard or
       * screen-reader user tabs into a navigation nobody can see.
       */}
      <Animated.View
        className={PANEL_CLASS}
        style={panelStyle}
        aria-hidden={!isOpen}
        pointerEvents={isOpen ? 'auto' : 'none'}
      >
        {/* The panel slides over the whole window, status bar and home indicator
            included, so it claims both insets itself rather than inheriting the
            shell's. No padding utility on this element — see the shell layout. */}
        <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
          <SideBar asDrawer onNavigate={close} />
        </SafeAreaView>
      </Animated.View>
    </View>
  );
});
