/**
 * The scrolling container for a page — native variant.
 *
 * Native needs a real `ScrollView`; the web variant is a plain `View` because
 * `global.css` deliberately hands scrolling back to the DOCUMENT there (a
 * `ScrollView` would create a nested overflow container inside a body that is
 * already the scroller). Platform-split into `.tsx` + `.web.tsx` rather than
 * branching on `Platform.OS`, so neither bundle carries the other's tree.
 */

import React from 'react';
import { ScrollView } from 'react-native';

import { useBottomBarReservedSpace } from '@/components/shell/BottomBar';

interface PageScrollProps {
  children: React.ReactNode;
}

export function PageScroll({ children }: PageScrollProps) {
  // The floating bar overlays the bottom of the window rather than taking space
  // in the layout, so the scroller has to leave room for it or the last line of
  // every page ends up underneath it. The bottom safe-area inset is already
  // folded into this number — never add it again. Above the bar's breakpoint the
  // bar is gone and this reads as a generous, harmless bottom margin.
  const reservedSpace = useBottomBarReservedSpace();

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="grow px-5 pt-4"
      contentContainerStyle={{ paddingBottom: reservedSpace }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
