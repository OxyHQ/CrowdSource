/**
 * Width breakpoints for the shell.
 *
 * These exist only for the decisions a NativeWind class genuinely cannot make:
 * MOUNT/UNMOUNT gates, so an off-breakpoint subtree never mounts (the right rail
 * and the bottom bar are whole trees, not styling), and the handful of places
 * that need the same boolean the shell laid out with. Pure show/hide and pure
 * styling differences use responsive classes directly.
 *
 * Backed by `useWindowDimensions`, which is reactive on resize and rotation on
 * every platform and safe under the React Compiler — no `matchMedia`, no
 * subscription of our own.
 */

import { useWindowDimensions } from 'react-native';

/**
 * >= 500px: wide enough for the rail and the framed panel.
 *
 * The same number `ContentPanel framedFrom={500}` uses in `app/(app)/_layout.tsx`,
 * so the rail, the panel's rounded frame and the sticky chrome's gutter inset all
 * appear and disappear together. Below it the shell is a single full-bleed column
 * with the floating bottom bar.
 */
export function useIsScreenNotMobile(): boolean {
  return useWindowDimensions().width >= 500;
}

/** >= 990px: wide enough for the right rail beside the panel. */
export function useIsRightBarVisible(): boolean {
  return useWindowDimensions().width >= 990;
}

/** >= 1300px: wide enough to expand the rail from icons to labelled rows. */
export function useIsSideBarExpanded(): boolean {
  return useWindowDimensions().width >= 1300;
}
