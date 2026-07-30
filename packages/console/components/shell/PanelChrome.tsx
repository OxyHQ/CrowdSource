/**
 * The panel's sticky chrome, and the inset it pins at.
 *
 * The reviewer app's `components/shell/PanelChrome.tsx` is the reference; this is that
 * module with everything the console does not need removed, and each removal is
 * deliberate.
 *
 * **No Reanimated.** The reviewer's header translates off-screen as the page scrolls,
 * which is right for a phone reading one case at a time and wrong for a table: an
 * operator scrolling a hundred deliveries needs the column titles and the filter chips
 * to stay where they are. Nothing here animates, so none of the three
 * Reanimated-on-web failure modes can apply.
 *
 * **No native branch.** This app is a web export. `position: sticky` in document flow is
 * the whole mechanism, and `global.css` is what hands scrolling back to the document so
 * there is a scroll container for it to pin within.
 *
 * **No second sticky LEVEL.** The reviewer stacks a tab bar under its header by pinning
 * it at `PANEL_TOP_INSET + PANEL_HEADER_HEIGHT`, which is only correct while the header
 * is exactly that tall — and a header with a subtitle, or a title long enough to wrap,
 * is taller, so the stacked row overlaps it by however much. Rather than measure the
 * header to fix the arithmetic, this module has ONE sticky element and `Screen` puts
 * both rows inside it: a block whose height is whatever its contents are cannot be
 * offset wrongly. `PANEL_HEADER_HEIGHT` survives only as the header row's MINIMUM.
 *
 * WEB layering: content < this chrome < the panel's own border frame, which
 * `ContentPanel` draws. The chrome must pin at `PANEL_TOP_INSET` and not `top: 0`,
 * because `ContentPanel` paints a gutter ring over the top `PANEL_TOP_INSET` px of the
 * viewport and a header at `top: 0` would be clipped by it. The opaque `bg-card` surface
 * plus the rounded top corners ALSO mask content bleeding into the panel's corners.
 */

import { PANEL_TOP_INSET } from '@oxyhq/bloom/content-panel';
import React from 'react';
import { View } from 'react-native';

import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { cn } from '@/lib/utils';

export { PANEL_TOP_INSET };

/** Minimum height (px) of the header row, so a title-only header is not cramped. */
export const PANEL_HEADER_HEIGHT = 48;

/** z-index the sticky chrome paints at: above content, below the panel's border frame. */
const CHROME_Z_INDEX = 101;

/**
 * The sticky inset, in BOTH shell states.
 *
 * NativeWind needs the class present as a literal string at build time, so the two
 * positions are spelled out rather than interpolated — but they are derived from
 * `PANEL_TOP_INSET`, and `__tests__/PanelChrome.test.ts` asserts the literals still
 * equal it so a change to Bloom's published gutter cannot leave them behind.
 *
 * `framed` pins at the gutter inset; `bleed` drops it, because below the panel's
 * breakpoint there is no gutter and a header offset by 8px would leave a stray band of
 * background above it.
 */
export const STICKY_TOP_CLASS: Record<'framed' | 'bleed', string> = {
  framed: 'web:top-2',
  bleed: 'web:top-0',
};

interface PanelStickyHeaderProps {
  children: React.ReactNode;
  /** Extra classes appended after the centralized chrome classes. */
  className?: string;
}

/**
 * The screen's chrome, pinned at the panel's top gutter inset.
 *
 * `bg-card` is not optional: the content scrolls BEHIND this, so a transparent header
 * shows rows sliding through the column titles.
 */
export function PanelStickyHeader({ children, className }: PanelStickyHeaderProps) {
  // The rounded frame (gutter inset + rounded corners) exists only at the same
  // breakpoint that frames the panel. Below it the shell is full-bleed, so the chrome
  // pins flush with no rounded top corners.
  const framed = useIsScreenNotMobile();
  return (
    <View
      className={cn(
        'left-0 right-0 bg-card web:sticky',
        STICKY_TOP_CLASS[framed ? 'framed' : 'bleed'],
        framed && 'web:rounded-t-[28px]',
        className,
      )}
      style={{ zIndex: CHROME_Z_INDEX }}
    >
      {children}
    </View>
  );
}
