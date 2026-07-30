/**
 * The scrolling container for a page.
 *
 * A plain `View`, and there is no `ScrollView` variant anywhere in this app.
 * `global.css` overrides react-native-web's fixed-viewport reset so the DOCUMENT
 * scrolls; wrapping a page in a `ScrollView` would put an `overflow: auto` box
 * inside that document and take the scroll away from the body again — which is
 * also what would stop `position: sticky` working for the panel header and for a
 * table's column titles.
 *
 * The reviewer app ships a `.tsx` + `.web.tsx` pair here because it has a native
 * bundle that needs a real scroller. This app is a web export, so there is one
 * file and no split to keep in sync.
 */

import React from 'react';
import { View } from 'react-native';

interface PageScrollProps {
  children: React.ReactNode;
}

export function PageScroll({ children }: PageScrollProps) {
  return <View className="grow">{children}</View>;
}
