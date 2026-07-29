/**
 * The native scroller reserves the header's height.
 *
 * This guards a bug that CANNOT be seen on web and is invisible in review.
 * `PanelStickyHeader level={0}` is `position: absolute; top: 0` on native by
 * design — the page is meant to scroll BEHIND it, with its height reserved as a
 * constant top inset so hiding the header never reflows the content being
 * scrolled. Web is unaffected: there the header is `position: sticky` in normal
 * flow and takes its own space.
 *
 * When the port first brought `PanelChrome` across, nothing supplied that inset
 * — `usePanelChromeTopInset` had no callers at all — so on a device the first
 * rows of every screen sat underneath the header. Every web check passed.
 *
 * The assertion is on the NATIVE variant specifically (`../PageScroll`, which
 * Metro resolves to `PageScroll.tsx`), because the web variant deliberately
 * ignores the inset and asserting against it would prove nothing.
 */

import { PanelChromeTopInsetProvider } from '@/components/shell/PanelChrome';
import React from 'react';
import { ScrollView, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { PageScroll } from '../PageScroll';

// `PanelChrome` imports reanimated, whose native half is absent under jest.
// Reanimated's OWN shipped mock does not help — `react-native-reanimated/mock`
// re-exports the real entry point, so requiring it throws the same
// initialization error it is supposed to avoid. `PanelChrome` uses exactly one
// thing from the module, `Animated.View`, and the inset under test is plain
// React context, so a `View` is a complete substitute here.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  return { __esModule: true, default: { View } };
});

jest.mock('@/components/BottomBar', () => ({
  useBottomBarReservedSpace: () => 70,
}));

jest.mock('@/context/LayoutScrollContext', () => ({
  useLayoutScroll: () => ({
    scrollPosition: { value: 0 },
    scrollEventThrottle: 16,
    handleScroll: jest.fn(),
  }),
}));

function renderWithInset(inset: number) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <PanelChromeTopInsetProvider value={inset}>
        <PageScroll>
          <Text>content</Text>
        </PageScroll>
      </PanelChromeTopInsetProvider>,
    );
  });
  if (!tree) throw new Error('render produced no tree');
  const scroller = tree.root.findByType(ScrollView);
  const style = scroller.props.contentContainerStyle;
  return Array.isArray(style) ? Object.assign({}, ...style) : style;
}

describe('PageScroll (native)', () => {
  it('reserves the header height handed to it as scrollable top padding', () => {
    // 79 rather than a round number on purpose: the header's height is measured,
    // not assumed, so a test that only passed for PANEL_HEADER_HEIGHT would keep
    // passing if the wiring were replaced by that constant.
    expect(renderWithInset(79).paddingTop).toBe(79);
  });

  it('tracks the inset rather than hardcoding one', () => {
    // Mutation guard for the assertion above: two different insets must produce
    // two different paddings, so a `paddingTop: 48` literal cannot satisfy both.
    expect(renderWithInset(48).paddingTop).toBe(48);
    expect(renderWithInset(56).paddingTop).toBe(56);
  });

  it('still leaves room for the floating bar at the bottom', () => {
    // The two insets are independent; reserving the header must not have cost
    // the bottom reservation, which is what stops the last row of every page
    // ending up under the floating bar.
    expect(renderWithInset(56).paddingBottom).toBe(70);
  });

  it('reserves nothing when no chrome is above it', () => {
    // The provider defaults to 0, so a scroller not under an overlay header is
    // unaffected — the inset must never become unconditional padding.
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        <PageScroll>
          <Text>content</Text>
        </PageScroll>,
      );
    });
    if (!tree) throw new Error('render produced no tree');
    const style = tree.root.findByType(ScrollView).props.contentContainerStyle;
    const flat = Array.isArray(style) ? Object.assign({}, ...style) : style;
    expect(flat.paddingTop).toBe(0);
  });
});
