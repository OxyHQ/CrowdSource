/**
 * The shell's destinations — the whole of them, in one place.
 *
 * The rail, the drawer and the bottom bar all read this list, so the three can
 * never drift into offering different things at different widths. Every entry is
 * one of the reviewer surfaces PLAN §4.1 defines, and the list is closed: there
 * is no case list, no search field and no "open a case" entry, because a case
 * arrives only when the server assigns one. The nearest thing to a case is the
 * button on Home that ASKS for one, and it lives there — with the eligibility,
 * consent and exposure state that decides whether asking is even possible —
 * rather than being duplicated as a shortcut in the chrome.
 *
 * The two surfaces deliberately absent are the ones that are not destinations:
 * `/review` renders the case currently assigned, and `/recuse` steps back from
 * it. Neither can be reached without an assignment, and putting them in a
 * permanent nav would read as somewhere you can go and look.
 */

import {
  Beaker_Stroke2_Corner2_Rounded,
  Clock_Stroke2_Corner0_Rounded,
  Growth_Stroke2_Corner0_Rounded,
  Heart2_Stroke2_Corner0_Rounded,
  Home_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';

/**
 * A Bloom icon component. Taken from an actual icon rather than hand-written so
 * it stays exact: every `@oxyhq/bloom/icons` export shares this type, and the
 * bar tints one by cloning it with a `fill`, which a looser type would not
 * guarantee.
 */
type ShellIcon = typeof Home_Stroke2_Corner0_Rounded;

export interface ShellDestination {
  /** Route, and the identity of the destination everywhere in the shell. */
  href: '/' | '/training' | '/history' | '/reliability' | '/wellbeing';
  /** i18n key for the label — see `nav.*` in `locales/`. */
  labelKey: string;
  /**
   * One glyph per destination, in outline. There is no filled twin: selection is
   * carried by the rail's pill and the bar's sliding highlight, both of which
   * also tint the glyph, so a second channel would only make the set look
   * inconsistent wherever Bloom has no filled variant to swap in.
   */
  icon: ShellIcon;
}

export const SHELL_DESTINATIONS: readonly ShellDestination[] = [
  { href: '/', labelKey: 'nav.home', icon: Home_Stroke2_Corner0_Rounded },
  { href: '/training', labelKey: 'nav.training', icon: Beaker_Stroke2_Corner2_Rounded },
  { href: '/history', labelKey: 'nav.history', icon: Clock_Stroke2_Corner0_Rounded },
  { href: '/reliability', labelKey: 'nav.reliability', icon: Growth_Stroke2_Corner0_Rounded },
  { href: '/wellbeing', labelKey: 'nav.wellbeing', icon: Heart2_Stroke2_Corner0_Rounded },
];
