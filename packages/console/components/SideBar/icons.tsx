/**
 * The rail's glyphs, resolved from the ids `lib/navigation.ts` emits.
 *
 * The mapping lives here rather than in the navigation module so that module stays
 * pure and importable in a test without Bloom. `fill="currentColor"` is what lets
 * `SideBarItem` tint a glyph through its wrapper's `text-*` class.
 */

import {
  BulletList_Stroke2_Corner0_Rounded,
  Clipboard_Stroke2_Corner2_Rounded,
  Group3_Stroke2_Corner0_Rounded,
  Growth_Stroke2_Corner0_Rounded,
  Home_Stroke2_Corner0_Rounded,
  Key_Stroke2_Corner2_Rounded,
  PaperPlane_Stroke2_Corner0_Rounded,
  Shield_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import React from 'react';

import type { NavIconId } from '@/lib/navigation';

/** Rendered size (px) of a rail glyph. */
const NAV_ICON_SIZE = 20;

export function NavIcon({ id }: { id: NavIconId }) {
  const props = {
    width: NAV_ICON_SIZE,
    height: NAV_ICON_SIZE,
    fill: 'currentColor',
  } as const;

  switch (id) {
    case 'organizations':
      return <Group3_Stroke2_Corner0_Rounded {...props} />;
    case 'overview':
      return <Home_Stroke2_Corner0_Rounded {...props} />;
    case 'credentials':
      return <Key_Stroke2_Corner2_Rounded {...props} />;
    case 'webhooks':
      return <PaperPlane_Stroke2_Corner0_Rounded {...props} />;
    case 'cases':
      return <BulletList_Stroke2_Corner0_Rounded {...props} />;
    case 'audit':
      return <Clipboard_Stroke2_Corner2_Rounded {...props} />;
    case 'trust-safety':
      return <Shield_Stroke2_Corner0_Rounded {...props} />;
    case 'metrics':
      return <Growth_Stroke2_Corner0_Rounded {...props} />;
  }
}
