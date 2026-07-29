/**
 * The app's navigation.
 *
 * Note what is not here: no case list, no search, no "open a case" entry. The
 * only way to a case is the server issuing an assignment, so the only related
 * destination is the button that ASKS for one, on the home screen.
 */

import { getNormalizedUserHandle } from '@oxyhq/core';
import { useAuth, useOxy } from '@oxyhq/services/ui/client';
import { Link, usePathname } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

const NAV_ITEMS = [
  { href: '/', labelKey: 'nav.home' },
  { href: '/training', labelKey: 'nav.training' },
  { href: '/history', labelKey: 'nav.history' },
  { href: '/reliability', labelKey: 'nav.reliability' },
  { href: '/wellbeing', labelKey: 'nav.wellbeing' },
] as const;

export function AppNav() {
  const { t } = useTranslation();
  const pathname = usePathname();

  return (
    <View className="border-b border-border bg-background">
      <View className="mx-auto w-full max-w-[720px] flex-row flex-wrap items-center gap-1 px-5 py-3">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={
                active
                  ? 'rounded-md bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground'
                  : 'rounded-md px-3 py-2 text-sm font-medium text-muted-foreground'
              }
            >
              {t(item.labelKey)}
            </Link>
          );
        })}
        <View className="flex-1" />
        <AccountButton />
      </View>
    </View>
  );
}

/**
 * The one door to the account.
 *
 * It opens the SDK's unified account dialog, which is where switching account,
 * adding one and signing out all live. This app writes no sign-out code of its
 * own: the session belongs to `OxyProvider`, and a second way to end it would
 * be a second authority over it.
 */
function AccountButton() {
  const { t } = useTranslation();
  const { user, openAccountDialog } = useOxy();
  const { isAuthResolved, isPrivateApiPending } = useAuth();

  // Until cold boot resolves, the identity is UNKNOWN — not signed out. A live
  // control here would offer an account dialog for an identity that does not
  // exist yet, and its label would change under the pointer the moment one
  // lands. The SDK's own `ProfileButton` renders a neutral placeholder through
  // the same window, for the same reason.
  if (!isAuthResolved || isPrivateApiPending) {
    return (
      <View className="rounded-md border border-border px-3 py-2 opacity-50">
        <Text className="text-sm font-medium text-muted-foreground">{t('nav.account')}</Text>
      </View>
    );
  }

  // Oxy owns identity: render `displayName` directly and fall back to the
  // normalized handle when a profile has none. Never recompose a name locally.
  const label = user?.name?.displayName?.trim() || getNormalizedUserHandle(user) || t('nav.account');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('nav.accountHint')}
      className="rounded-md border border-border px-3 py-2"
      onPress={() => openAccountDialog()}
    >
      <Text className="text-sm font-medium text-foreground">{label}</Text>
    </Pressable>
  );
}
