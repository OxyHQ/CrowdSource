/**
 * What the reputation widget shows, and what it refuses to depend on.
 *
 * Two of these guard things that cannot be seen in a browser here: no Oxy OAuth
 * client is registered for CrowdSource, so no session can exist locally and the
 * widget's signed-in branches never render in a manual check.
 *
 * The third guards a live upstream defect. The `/reputation/:id/balance`
 * response was narrowed for non-owners — they receive `userId`, `total` and
 * `trustTier` only — but `@oxyhq/core`'s types still declare `breakdown`,
 * `influence` and `reliability` as REQUIRED. TypeScript therefore states that
 * `balance.reliability.reportAccuracyScore` is safe when at runtime it is not.
 * A type that lies confidently cannot be leaned on, so the test feeds the widget
 * the real narrow shape and requires it to render anyway. If someone later
 * reaches for one of the absent fields, this fails rather than production.
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { ReputationWidget } from '../ReputationWidget';

const mockUseQuery = jest.fn();
const mockUseAuth = jest.fn();
const mockUseViewer = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock('@/lib/reviewer-api/use-reviewer-viewer', () => ({
  useReviewerViewer: () => mockUseViewer(),
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { getReputationBalance: jest.fn() },
}));

// Bloom's leaves resolve colours through `useTheme`, which throws outside a
// provider. Nothing under test is a colour, so they stand in as plain nodes.
jest.mock('@oxyhq/bloom/icons', () => ({
  Growth_Stroke2_Corner0_Rounded: () => null,
}));
jest.mock('@oxyhq/bloom/skeleton', () => ({
  Box: () => null,
}));

// `t` returns its own key, so an assertion names the STRING THE WIDGET CHOSE
// rather than today's English copy — the test cannot be broken by a rewording.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** Every string rendered anywhere in the tree. */
function textOf(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((node) => {
    const children = Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children];
    return children.filter((c: unknown) => typeof c === 'string' || typeof c === 'number')
      .map(String);
  });
}

function render(): TestRenderer.ReactTestRenderer {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(<ReputationWidget />);
  });
  if (!tree) throw new Error('render produced no tree');
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { id: 'user-1' } });
  mockUseViewer.mockReturnValue({ key: 'user:user-1', canQuery: true });
  mockUseQuery.mockReturnValue({ data: undefined, isPending: true, error: null });
});

describe('ReputationWidget', () => {
  it('says nothing has been recorded rather than showing a zero', () => {
    // The case essentially every reviewer is in today: reputation replaced karma
    // recently and almost nothing has been earned. A literal "0" reads as a
    // score being lost at; this must read as an absence.
    mockUseQuery.mockReturnValue({
      data: { userId: 'user-1', total: 0, trustTier: 'new' },
      isPending: false,
      error: null,
    });

    const text = textOf(render());
    expect(text).toContain('rightBar.reputation.none');
    expect(text).not.toContain('0');
  });

  it('shows the figure once something has been earned', () => {
    mockUseQuery.mockReturnValue({
      data: { userId: 'user-1', total: 42, trustTier: 'trusted' },
      isPending: false,
      error: null,
    });

    const text = textOf(render());
    expect(text).toContain('42');
    expect(text).not.toContain('rightBar.reputation.none');
  });

  it('renders from the NON-OWNER response shape without throwing', () => {
    // `userId`, `total` and `trustTier` and nothing else — what the server
    // actually returns to anyone who is not the subject. The published types
    // wrongly promise more; this asserts the widget never took them up on it.
    const narrow: { userId: string; total: number; trustTier: string } = {
      userId: 'user-1',
      total: 7,
      trustTier: 'high_trust',
    };
    mockUseQuery.mockReturnValue({ data: narrow, isPending: false, error: null });

    const text = textOf(render());
    expect(text).toContain('7');
    expect(text).toContain('rightBar.reputation.tier');
  });

  it('renders nothing at all before a session exists', () => {
    // Cold boot is not "signed out". Rendering a placeholder for a figure that
    // may never be requested would put a permanent skeleton in the rail of a
    // signed-out viewer.
    mockUseViewer.mockReturnValue({ key: null, canQuery: false });
    expect(render().toJSON()).toBeNull();
  });

  it('omits itself rather than putting an error in the rail', () => {
    mockUseQuery.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error('network'),
    });
    expect(render().toJSON()).toBeNull();
  });

  it('does not ask for a balance until the token is ready', () => {
    // `isAuthenticated` alone is not enough — a session can be committed a
    // moment before its access token is, and that window returns 401.
    mockUseViewer.mockReturnValue({ key: 'user:user-1', canQuery: false });
    render();
    const options = mockUseQuery.mock.calls[0]?.[0];
    if (options) {
      expect(options.enabled).toBe(false);
    }
  });
});
