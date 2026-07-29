/**
 * The scrolling container for a page — web variant.
 *
 * A plain `View`. `global.css` overrides react-native-web's fixed-viewport reset
 * so the DOCUMENT scrolls; wrapping the page in a `ScrollView` here would put an
 * `overflow: auto` box inside that document and take the scroll away from the
 * body again.
 *
 * No top inset and no scroll handler, unlike the native variant: the header is
 * `position: sticky` in normal flow here so it takes its own space, and the
 * document's scroll offset is published by the window listener in
 * `LayoutScrollProvider`.
 */

import React from 'react';
import { View } from 'react-native';

interface PageScrollProps {
  children: React.ReactNode;
}

export function PageScroll({ children }: PageScrollProps) {
  // No bottom padding, and none is missing. `app/(app)/_layout.tsx` already
  // reserves the floating bar's exact footprint on the panel below the bar's
  // breakpoint, and above it there is no bar to clear. The `pb-16` that used to
  // be here was counted on top of that reservation on a phone, and was 64px of
  // dead space at the end of every page on a desktop.
  return <View className="grow">{children}</View>;
}
