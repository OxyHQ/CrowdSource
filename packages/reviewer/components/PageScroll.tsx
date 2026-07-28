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

interface PageScrollProps {
  children: React.ReactNode;
}

export function PageScroll({ children }: PageScrollProps) {
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="grow px-5 pb-16 pt-4"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
