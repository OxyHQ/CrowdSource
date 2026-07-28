/**
 * The app's navigation.
 *
 * Note what is not here: no case list, no search, no "open a case" entry. The
 * only way to a case is the server issuing an assignment, so the only related
 * destination is the button that ASKS for one, on the home screen.
 */

import { Link, usePathname } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

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
      <View className="mx-auto w-full max-w-[720px] flex-row flex-wrap gap-1 px-5 py-3">
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
      </View>
    </View>
  );
}
