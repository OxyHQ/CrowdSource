/**
 * The one place the app's scroll offset is published.
 *
 * Mention's, subtracted. Mention carries a second, legacy `Animated.Value`
 * alongside the shared value (its profile banner and name fades still
 * interpolate on it) plus a registry of scrollables so tapping a tab scrolls
 * that screen back to the top. This app has neither, so only the reanimated
 * shared value survives — it is the single UI-thread input the chrome auto-hide
 * reads, and nothing else consumes scroll here.
 *
 * WEB is a document-scroll model (`global.css` hands scrolling back to the
 * body), so one window listener is the whole story. NATIVE has a real
 * `ScrollView` per screen, which feeds this through `handleScroll`.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

const IS_WEB = Platform.OS === 'web';

/** ~60fps. The scroll offset drives a UI-thread worklet, so it wants every frame. */
const SCROLL_EVENT_THROTTLE = 16;

interface ScrollEvent {
  nativeEvent?: {
    contentOffset?: { y?: number };
  };
}

interface LayoutScrollContextValue {
  /**
   * The global scroll offset, on the UI thread. Every scroller routes its offset
   * here, so a scroll-driven worklet subscribes to this ONE value rather than
   * running its own listener per screen.
   */
  scrollPosition: SharedValue<number>;
  scrollEventThrottle: number;
  /** Publish a native scroller's offset. Inert on web, where the window listener owns it. */
  handleScroll: (event: ScrollEvent) => void;
}

const LayoutScrollContext = createContext<LayoutScrollContextValue | null>(null);

export function LayoutScrollProvider({ children }: { children: React.ReactNode }) {
  const scrollPosition = useSharedValue(0);

  const handleScroll = useCallback(
    (event: ScrollEvent) => {
      scrollPosition.value = event.nativeEvent?.contentOffset?.y ?? 0;
    },
    [scrollPosition],
  );

  // Subscribing to an external mutable store — the window's scroll position —
  // is what an effect is for. There is no derived-state or event-handler form
  // of this: on web the scroller is the document, which no component owns.
  useEffect(() => {
    if (!IS_WEB || typeof window === 'undefined') return;
    const onWindowScroll = () => {
      scrollPosition.value = window.scrollY;
    };
    // Prime once, so a restored offset is reflected before the first gesture.
    onWindowScroll();
    window.addEventListener('scroll', onWindowScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onWindowScroll);
    };
  }, [scrollPosition]);

  const value = useMemo<LayoutScrollContextValue>(
    () => ({ scrollPosition, scrollEventThrottle: SCROLL_EVENT_THROTTLE, handleScroll }),
    [scrollPosition, handleScroll],
  );

  return <LayoutScrollContext.Provider value={value}>{children}</LayoutScrollContext.Provider>;
}

export function useLayoutScroll(): LayoutScrollContextValue {
  const ctx = useContext(LayoutScrollContext);
  if (!ctx) {
    throw new Error('useLayoutScroll must be used within a LayoutScrollProvider');
  }
  return ctx;
}
