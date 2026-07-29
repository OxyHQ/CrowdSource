/**
 * The panel's sticky chrome, and the insets it pins to.
 *
 * On web the routed content lives inside a rounded `ContentPanel` that floats in
 * an 8px gutter (`app/(app)/_layout.tsx`). A header that wants to stay put while
 * the document scrolls has to pin at that gutter inset rather than at `top: 0`:
 * the panel paints a 40px bleed-mask ring over the top of the viewport, so a
 * header flush against the edge would be clipped by it. The header's own opaque
 * surface and rounded top corners are what mask the content's bleed in the
 * panel's corners.
 *
 * The inset only exists while the frame does. The frame is gated on the same
 * 500px breakpoint as the rail, so below it the header pins flush and drops its
 * rounding, in lockstep — which is why the offsets are written as pairs of
 * literal classes rather than computed: NativeWind needs the whole class present
 * as a string at build time.
 *
 * NATIVE has no document scroll and nothing to mask, so the header is simply the
 * first row of the screen, and it carries no surface of its own — it already
 * sits on the panel's fill. Mention's version is an absolute overlay there
 * because its feeds scroll BEHIND an auto-hiding header; nothing here auto-hides,
 * and an overlay would just cover the first paragraph of every page.
 */

import React from 'react';
import { Platform, View } from 'react-native';

import { cn } from '@/lib/utils';
import { useIsScreenNotMobile } from '@/lib/responsive';

const IS_WEB = Platform.OS === 'web';

/**
 * z-index the chrome paints at on web — above the panel's bleed mask (30) and
 * below its border frame (120), so the mask never covers the header and the
 * frame still draws one unbroken outline over it.
 */
const CHROME_Z_INDEX = 101;

interface PanelStickyHeaderProps {
  children: React.ReactNode;
  /** Extra utilities appended after the centralized chrome classes. */
  className?: string;
}

export function PanelStickyHeader({ children, className }: PanelStickyHeaderProps) {
  // The framed shell (gutter inset + rounded corners) appears at the same width
  // as the rail. `web:top-2` is the panel's 8px gutter; `web:top-0` is the
  // full-bleed shell, where there is no gutter to clear.
  const framed = useIsScreenNotMobile();

  return (
    <View
      className={cn(
        'left-0 right-0',
        IS_WEB && 'web:sticky web:bg-card',
        IS_WEB && (framed ? 'web:top-2 web:rounded-t-[28px]' : 'web:top-0'),
        className,
      )}
      style={IS_WEB ? { zIndex: CHROME_Z_INDEX } : undefined}
    >
      {children}
    </View>
  );
}
