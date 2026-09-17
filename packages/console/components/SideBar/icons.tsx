/**
 * The rail's glyphs, resolved from the ids `lib/navigation.ts` emits.
 *
 * The mapping lives here rather than in the navigation module so that module stays
 * pure and importable in a test without Bloom. `fill="currentColor"` is what lets
 * `SideBarItem` tint a glyph through its wrapper's `text-*` class.
 */

import {
  RiListUnordered,
  RiClipboardLine,
  RiGroupLine,
  RiSeedlingLine,
  RiHomeLine,
  RiKey2Line,
  RiSendPlaneLine,
  RiShieldLine,
} from '@oxy.so/bloom/icons';
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
      return <RiGroupLine {...props} />;
    case 'overview':
      return <RiHomeLine {...props} />;
    case 'credentials':
      return <RiKey2Line {...props} />;
    case 'webhooks':
      return <RiSendPlaneLine {...props} />;
    case 'cases':
      return <RiListUnordered {...props} />;
    case 'audit':
      return <RiClipboardLine {...props} />;
    case 'trust-safety':
      return <RiShieldLine {...props} />;
    case 'metrics':
      return <RiSeedlingLine {...props} />;
  }
}
