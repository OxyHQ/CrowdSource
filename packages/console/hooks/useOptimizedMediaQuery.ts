import { useWindowDimensions } from 'react-native';

/**
 * Width-based breakpoints for the cases that genuinely need a JS boolean rather
 * than a NativeWind class: numeric layout math, and a decision two components have
 * to agree on.
 *
 * Pure show/hide and pure styling differences use NativeWind responsive classes
 * (`sm:`, `min-[900px]:`, …) directly — NOT these hooks.
 *
 * Backed by `useWindowDimensions` (reactive on resize, React-Compiler-safe) rather
 * than `matchMedia`, so there is one source of truth for a breakpoint whichever
 * side of the render it is read from.
 */

/**
 * >= 900px: the rail sits beside the content as a fixed, sticky column.
 *
 * Below it the rail stacks ABOVE the content as a full-width block instead of
 * disappearing. A console with no navigation on a narrow window cannot be used on a
 * split screen, and a hamburger drawer for a surface whose whole job is switching
 * between eight screens adds a click to every one of them.
 *
 * 900 rather than the reviewer app's 500: the rail carries application NAMES and the
 * content beside it is a table, and below 900 there is not enough width for both.
 */
export function useIsRailFixed(): boolean {
  return useWindowDimensions().width >= 900;
}

/**
 * >= 500px: the panel is framed — rounded corners inside an 8px gutter.
 *
 * This is `ContentPanel`'s own `framedFrom={500}` breakpoint, read here so the
 * sticky chrome pins at the gutter inset in exactly the states where the gutter
 * exists. The two must agree: chrome offset by 8px with no frame under it leaves a
 * stray band of background above the header.
 */
export function useIsScreenNotMobile(): boolean {
  return useWindowDimensions().width >= 500;
}
