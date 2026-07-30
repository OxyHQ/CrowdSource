/**
 * The rail: what this session can reach, and which application it is looking at.
 *
 * Three things are worth stating about it.
 *
 * **The Trust & Safety section is absent, not disabled, for a session with no staff
 * role** — and that is a courtesy, not the boundary. Every Trust & Safety route
 * checks its own role and answers 403; hiding the entry keeps a developer from being
 * shown a door that is not theirs. The decision itself is `buildNavigation` in
 * `lib/navigation.ts`, pure and tested there, so it cannot be quietly changed by an
 * edit to this component.
 *
 * **The application switcher IS the list.** Rather than a dropdown, the sibling
 * applications of the current application's organization are rows in the rail, with
 * the current one active. A console operator switches between two or three
 * applications all day; a control that has to be opened to see what it contains adds
 * a click to the commonest action on the screen. The list is scoped to ONE
 * organization because that is the query the API offers — a cross-organization list
 * would be N requests, and `/` already shows every organization.
 *
 * **Below 900px the rail stacks above the content instead of vanishing.** There is
 * no drawer and no hamburger: this app is eight screens an operator moves between
 * constantly, and putting them behind a tap would cost a click on each.
 */

import { ProfileButton } from '@oxyhq/services';
import { useAuth } from '@oxyhq/services/ui/client';
import { usePathname } from 'expo-router';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { LogoIcon } from '@/components/LogoIcon';
import { NavIcon } from '@/components/SideBar/icons';
import { SideBarItem } from '@/components/SideBar/SideBarItem';
import { useIsRailFixed } from '@/hooks/useOptimizedMediaQuery';
import { useApplication, useApplications, useConsoleSession } from '@/lib/console-api/queries';
import { createScopedLogger } from '@/lib/logger';
import { applicationIdFromPathname, buildNavigation, isCurrentEntry } from '@/lib/navigation';
import { cn } from '@/lib/utils';

const logger = createScopedLogger('SideBar');

/** Rail width (px) when it is a fixed column. Fits an application name. */
const RAIL_WIDTH = 248;

export function SideBar() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const isFixed = useIsRailFixed();
  const { signIn } = useAuth();
  const applicationId = applicationIdFromPathname(pathname);

  const session = useConsoleSession();
  // The rail's own copy of the application, which is the SAME cache entry the
  // overview screen reads — one request, not two.
  const application = useApplication(applicationId);
  const organizationId = application.data?.organizationId ?? null;
  const siblings = useApplications(organizationId);

  const sections = buildNavigation({
    staffRoles: session.data?.staffRoles ?? [],
    applicationId,
  });

  // Adding another account goes through the SDK's own sign-in flow. An operator
  // holding both a staff account and a developer account is the ordinary case here.
  const handleAddAccount = useCallback(() => {
    signIn().catch((error: unknown) => {
      logger.warn('Add-account flow did not complete', { error });
    });
  }, [signIn]);

  return (
    // When fixed: `alignSelf: flex-start` plus `100vh` is what lets the rail stay put
    // while the document scrolls — a flex child would otherwise stretch to the row's
    // full scrollable height, leaving `sticky` nothing to move within.
    // `overflow-y-auto` is on the rail itself, never on the document (see
    // global.css for why an overflow there steals the page's scroll).
    <View
      className={cn(
        'bg-background p-3',
        isFixed
          ? 'shrink-0 self-start web:sticky web:top-0 web:h-screen web:overflow-y-auto'
          : 'w-full border-b border-border',
      )}
      style={isFixed ? { width: RAIL_WIDTH } : undefined}
    >
      <View className={cn('gap-1', isFixed && 'flex-1')}>
        <View className="flex-row items-center gap-2 px-2.5 pb-3">
          <LogoIcon height={22} />
          <Text className="text-sm font-bold text-foreground">{t('app.name')}</Text>
        </View>

        {sections.map((section) => (
          <View key={section.labelKey ?? 'root'} className="gap-0.5 pb-2">
            {section.labelKey ? (
              <Text className="px-2.5 pb-1 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                {t(section.labelKey)}
              </Text>
            ) : null}

            {/* The application's own name sits above its screens, so the section
                says WHICH application "Credentials" belongs to. Not a link: the
                overview immediately below it is that destination. */}
            {section.labelKey === 'nav.application' && application.data ? (
              <Text
                className="px-2.5 pb-1 text-sm font-semibold text-foreground"
                numberOfLines={1}
                selectable
              >
                {application.data.name}
              </Text>
            ) : null}

            {section.entries.map((entry) => (
              <SideBarItem
                key={entry.href}
                label={t(entry.labelKey)}
                href={entry.href}
                isActive={isCurrentEntry(entry, pathname)}
                icon={<NavIcon id={entry.icon} />}
              />
            ))}
          </View>
        ))}

        {/* The switcher. Present only when there is more than one application to
            switch between — a single-application organization does not need a list
            of one, and an empty section reads as something failing to load. */}
        {applicationId !== null && (siblings.data?.length ?? 0) > 1 ? (
          <View className="gap-0.5 pb-2">
            <Text className="px-2.5 pb-1 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('nav.switchApplication')}
            </Text>
            {siblings.data?.map((sibling) => (
              <SideBarItem
                key={sibling.applicationId}
                label={sibling.name}
                href={`/applications/${encodeURIComponent(sibling.applicationId)}`}
                isActive={sibling.applicationId === applicationId}
              />
            ))}
          </View>
        ) : null}
      </View>

      {/* Account trigger. ProfileButton owns all three auth states (undetermined
          skeleton, signed-in row + account switcher, signed-out "Sign in") and the
          device-account switcher menu.

          `onNavigateManage` and `onNavigateProfile` are omitted ON PURPOSE. The
          console has no settings screen and no profile screen: an operator's
          identity is Oxy's, and account management lives at accounts.oxy.so, which
          the account dialog already reaches. The SDK registers a menu entry only
          for the handlers it is given, so leaving these out removes the entries —
          which is the wanted result. Do NOT wire them to a route invented to
          satisfy them. */}
      <View className={cn(isFixed ? 'pt-2' : 'pt-1')}>
        <ProfileButton expanded onAddAccount={handleAddAccount} />
      </View>
    </View>
  );
}
