/**
 * The shared chrome auto-hide signal.
 *
 * Mention's, subtracted: Mention pins the chrome permanently visible on its
 * immersive Reels route, and this app has no route that wants that, so the
 * exception list is gone and the reaction always drives.
 *
 * `hidden` is CONTINUOUS in [0, 1] — 0 fully shown, 1 fully hidden. One driver
 * for the whole `(app)` group: the header reads it for its translate and the
 * floating bar minimizes off the same integration, so the two can never drift
 * apart or run two competing scroll listeners.
 *
 * ARCHITECTURE — UI-thread, scroll-driven, clamped. A `useAnimatedReaction`
 * worklet on the shared scroll position integrates each frame's delta into a
 * clamped `hideAmount` and normalizes it:
 *
 *     dy         = y - prevY
 *     hideAmount = clamp(hideAmount + dy, 0, HIDE_SCROLL_RANGE)
 *     hidden     = hideAmount / HIDE_SCROLL_RANGE
 *
 * Because the value is continuous — no bistable direction flag, no `withTiming`
 * target to flip — it is structurally incapable of the oscillation a
 * direction-toggle produces. And the reflow feedback that would drive such a
 * loop is removed at the source: the header is an overlay that only translates,
 * and the scroller reserves its height as a constant inset, so hiding the
 * chrome never reflows the content that is being scrolled.
 */

import { setMinimized, useMinimizeState } from '@oxyhq/bloom/tab-bar';
import { usePathname } from 'expo-router';
import React, { createContext, useContext, useEffect } from 'react';
import { useAnimatedReaction, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { useLayoutScroll } from '@/context/LayoutScrollContext';

/**
 * Scroll distance (px) over which the chrome travels from fully shown to fully
 * hidden. Roughly the chrome's own height, so a deliberate scroll hides it
 * within one short gesture while a finger wobble only nudges it a few px.
 */
const HIDE_SCROLL_RANGE = 90;

/**
 * Offset (px) below which the chrome is pinned fully shown, so it never ends up
 * half-hidden at the top of a page and returning to the top always resolves to
 * a clean shown state.
 */
const HIDE_ACTIVATION_OFFSET = 50;

/**
 * Largest single-frame delta (px) a real gesture plausibly produces. Anything
 * bigger is programmatic — scroll restoration, a deep link, the focused
 * scroller changing on navigation — and must not be integrated as a hide
 * gesture. It re-baselines only.
 */
const PROGRAMMATIC_JUMP_THRESHOLD = 200;

const BottomBarVisibilityContext = createContext<SharedValue<number> | null>(null);

export function BottomBarVisibilityProvider({ children }: { children: React.ReactNode }) {
  const { scrollPosition } = useLayoutScroll();
  const pathname = usePathname();
  // Bloom's shared minimize progress for the floating bar. Read here — the one
  // place that already integrates scroll direction — so the bar shrinks off the
  // SAME driver as the header instead of a second scroll handler. It needs
  // <TabBarMinimizeProvider> above, which comes from the single <BloomProvider>
  // in `app/_layout.tsx`; without one this silently hands out a private fallback
  // and the bar never minimizes, with no error anywhere.
  const minimizeState = useMinimizeState();

  const hidden = useSharedValue(0);
  // Clamped running sum of scroll delta. `hidden` is this normalized. Kept as
  // its own value rather than derived from a direction flag: that is what makes
  // it continuous.
  const hideAmount = useSharedValue(0);

  // Every screen opens with its chrome shown, and the bar at full size — without
  // this, leaving a scrolled screen opens the next one with a shrunken pill and
  // a header already half gone.
  useEffect(() => {
    hideAmount.value = 0;
    hidden.value = 0;
    setMinimized(minimizeState, 0);
  }, [pathname, hidden, hideAmount, minimizeState]);

  useAnimatedReaction(
    () => scrollPosition.value,
    (y, prevY) => {
      'worklet';
      const previous = prevY ?? y;
      const dy = y - previous;
      if (dy > PROGRAMMATIC_JUMP_THRESHOLD || dy < -PROGRAMMATIC_JUMP_THRESHOLD) {
        return;
      }
      let next: number;
      if (y <= HIDE_ACTIVATION_OFFSET) {
        next = 0;
      } else {
        next = hideAmount.value + dy;
        if (next < 0) next = 0;
        else if (next > HIDE_SCROLL_RANGE) next = HIDE_SCROLL_RANGE;
      }
      hideAmount.value = next;
      hidden.value = next / HIDE_SCROLL_RANGE;
      // `setMinimized` is itself a worklet and no-ops when the target is
      // unchanged, so this costs nothing on the frames between the two states.
      setMinimized(minimizeState, next > HIDE_SCROLL_RANGE / 2 ? 1 : 0);
    },
    [scrollPosition, hidden, hideAmount, minimizeState],
  );

  return (
    <BottomBarVisibilityContext.Provider value={hidden}>
      {children}
    </BottomBarVisibilityContext.Provider>
  );
}

/**
 * Read the shared auto-hide signal (0 shown, 1 hidden). Consumers map it to
 * their own transform, so one continuous value keeps every piece of chrome in
 * lock-step.
 */
export function useBottomBarHidden(): SharedValue<number> {
  const ctx = useContext(BottomBarVisibilityContext);
  if (!ctx) {
    throw new Error('useBottomBarHidden must be used within a BottomBarVisibilityProvider');
  }
  return ctx;
}
