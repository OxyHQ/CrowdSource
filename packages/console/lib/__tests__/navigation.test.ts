/**
 * The rail's contents, including the one decision in it that is security-relevant.
 *
 * The Trust & Safety section exists only for a session holding a staff role. That is a
 * COURTESY — the routes behind it check their own role and answer 403 — but it is the
 * courtesy that keeps a developer from being shown a door that is not theirs, and it is
 * the kind of thing an edit to a component can silently undo.
 */

import {
  applicationIdFromPathname,
  buildNavigation,
  isCurrentEntry,
  type NavSection,
} from '@/lib/navigation';

function labelKeys(sections: NavSection[]): string[] {
  return sections.flatMap((section) => section.entries.map((entry) => entry.labelKey));
}

describe('buildNavigation', () => {
  it('shows no Trust & Safety entry to a session with no staff role', () => {
    const sections = buildNavigation({ staffRoles: [], applicationId: null });
    expect(labelKeys(sections)).toEqual(['nav.organizations']);
    expect(JSON.stringify(sections)).not.toContain('trust-safety');
  });

  it('shows the Trust & Safety section to any staff role', () => {
    // Any role at all: the individual routes are narrower, and a staff member with
    // `appeals` reaching the section and being refused by the route is the correct
    // shape.
    for (const role of ['policy', 'appeals', 'evidence', 'security'] as const) {
      const sections = buildNavigation({ staffRoles: [role], applicationId: null });
      expect(labelKeys(sections)).toContain('nav.applicationTrust');
      expect(labelKeys(sections)).toContain('nav.platformMetrics');
    }
  });

  it('omits the application entries entirely when no application is selected', () => {
    // Absent rather than disabled: a "Credentials" row that cannot say whose
    // credentials is not a destination.
    const sections = buildNavigation({ staffRoles: ['security'], applicationId: null });
    expect(labelKeys(sections)).not.toContain('nav.credentials');
  });

  it('builds every application entry under the selected application', () => {
    const sections = buildNavigation({ staffRoles: [], applicationId: 'app_1' });
    const hrefs = sections.flatMap((section) => section.entries.map((entry) => entry.href));
    expect(hrefs).toEqual([
      '/',
      '/applications/app_1',
      '/applications/app_1/credentials',
      '/applications/app_1/webhooks',
      '/applications/app_1/cases',
      '/applications/app_1/audit',
    ]);
  });

  it('encodes an application id that needs it', () => {
    // The id reaches this function from a URL. An unencoded value would build an href
    // that resolves to a different route than the one intended.
    const sections = buildNavigation({ staffRoles: [], applicationId: 'a/b' });
    const hrefs = sections.flatMap((section) => section.entries.map((entry) => entry.href));
    expect(hrefs).toContain('/applications/a%2Fb');
  });

  it('emits translation KEYS and never a user-visible string', () => {
    // The module has no locale, which is what lets it be tested without i18n.
    const sections = buildNavigation({ staffRoles: ['security'], applicationId: 'app_1' });
    for (const key of labelKeys(sections)) {
      expect(key.startsWith('nav.')).toBe(true);
    }
  });
});

describe('isCurrentEntry', () => {
  it('matches exactly, so a nested route does not light its parent', () => {
    // A prefix match would highlight "Overview" while a case detail is open, and two
    // rows highlighted at once is worse than none.
    const entry = { labelKey: 'nav.overview', href: '/applications/app_1', icon: 'overview' } as const;
    expect(isCurrentEntry(entry, '/applications/app_1')).toBe(true);
    expect(isCurrentEntry(entry, '/applications/app_1/cases')).toBe(false);
  });
});

describe('applicationIdFromPathname', () => {
  it('reads the id out of an application route', () => {
    expect(applicationIdFromPathname('/applications/app_1')).toBe('app_1');
    expect(applicationIdFromPathname('/applications/app_1/webhooks')).toBe('app_1');
    expect(applicationIdFromPathname('/applications/app_1/cases/case_1')).toBe('app_1');
  });

  it('decodes the segment, because it came from a URL', () => {
    expect(applicationIdFromPathname('/applications/a%2Fb/cases')).toBe('a/b');
  });

  it('reports no application anywhere else', () => {
    expect(applicationIdFromPathname('/')).toBeNull();
    expect(applicationIdFromPathname('/trust-safety')).toBeNull();
    expect(applicationIdFromPathname('/organizations/org_1/members')).toBeNull();
    expect(applicationIdFromPathname('/applications')).toBeNull();
    expect(applicationIdFromPathname('/applications/')).toBeNull();
  });

  it('treats a malformed escape as no application rather than throwing', () => {
    // A rail that throws during render takes the whole shell with it, and an operator
    // editing a URL is exactly how a stray `%` gets there.
    expect(applicationIdFromPathname('/applications/%E0%A4%A')).toBeNull();
  });
});
