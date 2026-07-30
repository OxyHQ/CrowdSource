/**
 * What is in the rail, decided as data.
 *
 * A pure function rather than JSX in the sidebar, because one of its outputs is a
 * security-relevant decision: the Trust & Safety section exists only for a session
 * that holds a staff role. Keeping that in a component would mean the only way to
 * exercise it is to render the app with a fabricated session; here it is a table in
 * a test (`lib/__tests__/navigation.test.ts`).
 *
 * Hiding the section does NOT enforce anything — the Trust & Safety routes check
 * their own role and answer 403 to any session without one. What it does is keep a
 * developer from being shown a door that is not theirs, which is a different and
 * lesser goal.
 *
 * Labels are translation KEYS and icons are ids, so this module needs neither i18n
 * nor Bloom to be imported. `components/SideBar` resolves both.
 */

import { hasTrustSafetyAccess } from '@/lib/console-api/roles';
import type { StaffRole } from '@/lib/console-api/types';

/** The glyphs the rail uses. `components/SideBar/icons.tsx` owns the mapping. */
export type NavIconId =
  | 'organizations'
  | 'overview'
  | 'credentials'
  | 'webhooks'
  | 'cases'
  | 'audit'
  | 'trust-safety'
  | 'metrics';

export interface NavEntry {
  /** i18n key. Never a user-visible string — this module has no locale. */
  labelKey: string;
  /** An expo-router pathname. Application entries already carry the id. */
  href: string;
  icon: NavIconId;
}

export interface NavSection {
  /** i18n key for the section heading, or null for the unlabelled first block. */
  labelKey: string | null;
  entries: NavEntry[];
}

export interface NavigationInput {
  staffRoles: readonly StaffRole[];
  /**
   * The application currently being looked at, or null at the top level.
   *
   * The application entries are absent rather than disabled when it is null: a
   * "Credentials" row that cannot say whose credentials is not a destination.
   */
  applicationId: string | null;
}

/**
 * Builds the rail.
 *
 * The order is the order of a developer's day: what they own, then the keys that
 * let their service talk to ours, then whether it is being delivered to, then the
 * cases that came back, then the record of it. Trust & Safety is last and
 * separated, because it is a different job.
 */
export function buildNavigation({ staffRoles, applicationId }: NavigationInput): NavSection[] {
  const sections: NavSection[] = [
    {
      labelKey: null,
      entries: [{ labelKey: 'nav.organizations', href: '/', icon: 'organizations' }],
    },
  ];

  if (applicationId !== null) {
    const base = `/applications/${encodeURIComponent(applicationId)}`;
    sections.push({
      labelKey: 'nav.application',
      entries: [
        { labelKey: 'nav.overview', href: base, icon: 'overview' },
        { labelKey: 'nav.credentials', href: `${base}/credentials`, icon: 'credentials' },
        { labelKey: 'nav.webhooks', href: `${base}/webhooks`, icon: 'webhooks' },
        { labelKey: 'nav.cases', href: `${base}/cases`, icon: 'cases' },
        { labelKey: 'nav.audit', href: `${base}/audit`, icon: 'audit' },
      ],
    });
  }

  if (hasTrustSafetyAccess(staffRoles)) {
    sections.push({
      labelKey: 'nav.trustSafety',
      entries: [
        { labelKey: 'nav.applicationTrust', href: '/trust-safety', icon: 'trust-safety' },
        { labelKey: 'nav.platformMetrics', href: '/trust-safety/metrics', icon: 'metrics' },
      ],
    });
  }

  return sections;
}

/**
 * Whether `pathname` is the entry's own destination.
 *
 * Exact match, deliberately. A prefix match would light "Overview" up while a case
 * detail is open, because the case route is nested under the application base —
 * and two rows highlighted at once is worse than none.
 */
export function isCurrentEntry(entry: NavEntry, pathname: string): boolean {
  return entry.href === pathname;
}

/**
 * The application the current URL is about, read from the path.
 *
 * The rail needs this and sits ABOVE the `[applicationId]` route, so the parameter
 * is not in its own local params. Reading the pathname is preferred over
 * `useGlobalSearchParams` for two reasons: that hook re-renders its subscriber on
 * every navigation anywhere in the app (documented), and a pure function over a
 * string is something a test can exercise directly.
 *
 * The segment is decoded because it arrives from a URL. A malformed escape is
 * treated as no application rather than allowed to throw out of a layout render —
 * a rail that crashes takes the whole shell with it.
 */
export function applicationIdFromPathname(pathname: string): string | null {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 2 || segments[0] !== 'applications') {
    return null;
  }
  try {
    const decoded = decodeURIComponent(segments[1]);
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}
