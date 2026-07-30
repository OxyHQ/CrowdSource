/**
 * A secret that will never be shown again, presented as one.
 *
 * Two values reach a screen exactly once: a service credential's token and a
 * rotated webhook secret. Only their digests are stored, so nothing — including the
 * service — can serve either a second time. That fact has to be on the screen, in
 * words, BEFORE the operator navigates away, because the alternative is issuing a
 * second credential and leaving the first one live and unowned.
 *
 * So this component is not a styled text box. It is:
 *
 *  - a warning that says the value is shown once,
 *  - the value, monospaced, selectable and with a copy affordance,
 *  - an explicit dismissal, so leaving the screen is a decision rather than an
 *    accident.
 *
 * The value lives in the caller's component state and is never written to the query
 * cache, to `AsyncStorage` or to a log. Nothing here persists it, and there is no
 * "show again" — that control cannot exist.
 */

import { Admonition } from '@oxyhq/bloom/admonition';
import { Button } from '@oxyhq/bloom/button';
import React, { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { CopyValue } from '@/components/data/CopyValue';
import { Panel } from '@/components/Screen';

interface OneTimeSecretProps {
  /** Already-localized heading naming what was issued. */
  title: string;
  /** The secret itself. Shown once; never re-fetched. */
  value: string;
  /** Already-localized name of the value, for the copy affordance. */
  valueLabel: string;
  /** Facts about the new secret that are not the secret: a version, an instant. */
  details?: ReactNode;
  onDismiss: () => void;
}

export function OneTimeSecret({
  title,
  value,
  valueLabel,
  details,
  onDismiss,
}: OneTimeSecretProps) {
  const { t } = useTranslation();

  return (
    <Panel title={title}>
      <Admonition type="warning">{t('secret.shownOnce')}</Admonition>

      <CopyValue value={value} label={valueLabel} layout="block" />

      {details}

      <Text className="text-xs leading-4 text-muted-foreground">{t('secret.storeIt')}</Text>

      <View className="flex-row justify-end">
        <Button variant="secondary" size="small" onPress={onDismiss}>
          {t('secret.dismiss')}
        </Button>
      </View>
    </Panel>
  );
}
