/**
 * The right rail, from 990px up.
 *
 * Mention puts search and recommendations here. Neither has an equivalent in a
 * product where you cannot look for anything, so this rail restates the three
 * rules that govern every screen instead. They are worth repeating: a reviewer
 * who forgets that recusal is free is a reviewer who pushes through a case they
 * should have stepped back from.
 *
 * It shows no state. Nothing about the queue, nothing about how many cases are
 * waiting, nothing about the case in hand — a rail that is always on screen is
 * the worst possible place to leak any of it, and a standing summary of the
 * reviewer's own figures would only be Home's, duplicated and one fetch behind.
 */

import React from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Link } from 'expo-router';

import { Panel } from '@/components/Screen';
import { useIsRightBarVisible } from '@/lib/responsive';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('RightBar');

/** The three rules, in the order they matter to somebody mid-case. */
const PRINCIPLE_KEYS = [
  'rightBar.principles.assigned',
  'rightBar.principles.blind',
  'rightBar.principles.recusal',
] as const;

/** Policy pages. Oxy's, because the policies are Oxy's. */
const FOOTER_LINKS = [
  { key: 'privacy', url: 'https://oxy.so/company/transparency/policies/privacy' },
  { key: 'terms', url: 'https://oxy.so/company/transparency/policies/terms-of-service' },
  { key: 'cookies', url: 'https://oxy.so/company/transparency/policies/cookies' },
] as const;

export function RightBar() {
  const { t } = useTranslation();
  const isVisible = useIsRightBarVisible();

  // A mount gate, not a style: below 990px this whole subtree stays unbuilt.
  if (!isVisible) {
    return null;
  }

  return (
    // `top-0` with a 8px top pad puts the first card's top edge exactly on the
    // panel's, which is the panel's own gutter inset — the two columns read as
    // one band rather than two things that nearly line up. `self-start` keeps the
    // sticky box from being stretched to the tall shell row's height, which would
    // leave it nowhere to pin.
    <View className="w-[350px] flex-col gap-4 px-4 pt-2 web:sticky web:top-0 web:self-start">
      <Panel title={t('rightBar.principles.title')}>
        {PRINCIPLE_KEYS.map((key) => (
          <Text key={key} className="text-sm leading-5 text-muted-foreground">
            {t(key)}
          </Text>
        ))}
      </Panel>

      <Panel title={t('rightBar.support.title')} description={t('rightBar.support.body')}>
        <Link href="/wellbeing" className="text-sm font-semibold text-primary">
          {t('rightBar.support.action')}
        </Link>
      </Panel>

      {Platform.OS === 'web' ? <RightBarFooter /> : null}
    </View>
  );
}

function RightBarFooter() {
  const { t } = useTranslation();

  return (
    <View className="flex-row flex-wrap pb-3">
      {FOOTER_LINKS.map((link) => (
        <FooterLink key={link.key} label={t(`rightBar.footer.${link.key}`)} url={link.url} />
      ))}
      <FooterLink label="Oxy" url="https://oxy.so/" />
    </View>
  );
}

/**
 * Its own component so each link's press handler is stable through component
 * identity rather than a fresh closure per render of the list.
 */
const FooterLink = React.memo(function FooterLink({ label, url }: { label: string; url: string }) {
  return (
    <Text
      className="pb-1 pr-3 text-[12.5px] text-muted-foreground web:cursor-pointer"
      onPress={() => {
        Linking.openURL(url).catch((error: unknown) => {
          logger.warn('Could not open an external link', { url, error });
        });
      }}
    >
      {label}
    </Text>
  );
});
