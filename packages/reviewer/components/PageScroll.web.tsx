/**
 * The scrolling container for a page — web variant.
 *
 * A plain `View`. `global.css` overrides react-native-web's fixed-viewport reset
 * so the DOCUMENT scrolls; wrapping the page in a `ScrollView` here would put an
 * `overflow: auto` box inside that document and take the scroll away from the
 * body again.
 */

import React from 'react';
import { View } from 'react-native';

interface PageScrollProps {
  children: React.ReactNode;
}

export function PageScroll({ children }: PageScrollProps) {
  return <View className="grow px-5 pb-16 pt-4">{children}</View>;
}
