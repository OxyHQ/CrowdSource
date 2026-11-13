# Frontend composition adoption

Both frontends already mount `BloomProvider`. Their signed-in shells still own
responsive navigation, surface placement and route chrome outside Bloom's
compositor. The root authentication decision and identity boundaries are product
policy and must remain in place when that layout ownership changes.

## Reviewer

The shell shows a 60-pixel icon rail from 500 pixels and expands it to 240 pixels
from 1300. A right column appears from 990; the content and right column share a
950-pixel maximum. The panel has an eight-pixel desktop gutter and no start gutter
beside the rail. Below 500, navigation uses the existing drawer and floating
Bloom TabBar.

`LayoutScrollContext` reads the document or native ScrollView. The local
`BottomBarVisibilityContext` integrates scroll deltas into a continuous hide
amount, clamped to 0–90 pixels. Offsets at or below 50 reset it; a single delta
greater than 200 pixels is ignored as a programmatic jump. The header translates
by that fraction of its measured height, and the bar changes its minimize target
at the midpoint. A route arrival resets both.

This differs from Bloom Screen's current timed, directional collapse target.
Replacing one with the other would change interaction. A shared scroll policy
must preserve the continuous value, ignored jumps, arrival reset and measured
header clearance before the local coordination can be removed.

Observed with synthetic onboarding content: the header is 48 pixels tall at
1280 and 80 at 390. Wheel deltas 60, 30, 30, -30, -30 produce offsets 60, 90,
120, 90, 60 and header fractions 2/3, 1, 1, 2/3, 1/3. A partial value remains
unchanged after 1.2 seconds. A jump from 60 to 450 preserves that value; the next
-30 gesture integrates normally. Navigating to Training and back currently
returns to offset zero with the header visible. These are baseline behaviors,
not a claim that route restoration has already been adopted.

At 390 × 900, the actual TabBar measures 366 × 58 at y826 when expanded and
298 × 44 at y840 when minimized. It remains minimized through a held partial
header state and the ignored jump, then expands when the accumulated hide amount
crosses back below the midpoint. The shared contract must retain that relation
without creating a second scroll listener or a delayed React state bridge.

## Console

The navigation is a 248-pixel sticky column from 900 pixels. Below 900 it remains
visible as a full-width block before the panel. It is not a drawer or bottom bar.
The panel becomes framed from 500, independently of the navigation arrangement,
and its content is capped at 1440 pixels.

The current AppShell compact-navigation contract switches to a drawer. It needs
an inline stacked arrangement before it can replace this shell without changing
the product's navigation. Keep the navigation tree and its application-switching
state stable across the breakpoint.

The route title, subtitle, actions and optional toolbar form one sticky block.
Its actual combined height determines the content boundary; a toolbar must not
use a fixed offset that assumes a single title row. With eight synthetic
organizations, the 900-pixel viewport has a header at x248/y8, width644, height63.
At 899, the navigation occupies 205 pixels and the framed header starts at
x8/y213, width883. At 390 the unframed header starts at y205 and grows to79 pixels.

## Verification boundary

Use synthetic sessions and synthetic GET responses only, and block all external
HTTP and WebSocket traffic in the browser harness. Never load moderation cases,
credentials, real membership data or real business actions to verify layout.
Wait for the route heading and content before capturing: a blank first paint
with no page errors is not a valid baseline.

Check both sides of 500, 900, 990 and 1300, document overflow, actual wheel input,
header and toolbar pinning, navigation persistence, and the mobile bar. Verify
native measurements separately; Chromium does not establish native safe-area,
keyboard or retained-stack behavior. Local Bloom packages are temporary test
artifacts and must be restored before the published-package typecheck.
