/**
 * The sensitive-material gate (PLAN §13.7).
 *
 * The plan asks for "blur y advertencia antes de revelar medios sensibles". This
 * does something strictly stronger: until the reviewer asks for it, the material
 * is not rendered at all. A blur is a filter over content that is already on
 * screen — it can be peeked past, screenshotted, or lost to a style regression.
 * Content that was never mounted cannot leak.
 *
 * Consent is checked before the reveal is even offered. A reviewer who has not
 * consented to this category gets no reveal button, only a pointer to the
 * wellbeing screen where consent is granted — and where it can be taken back
 * again at any time, which is the other half of §13.7.
 */

import { Button } from '@oxyhq/bloom/button';
import type { ReviewerSensitivityClass, TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

interface SensitiveGateProps {
  /**
   * What the reviewer is warned about BEFORE anything can be revealed: the class
   * triage computed, and the codes that were alleged.
   *
   * There is no separate `warnings` list on the wire and there never was. §9.1's
   * "advertencias" are these two facts — a third field would mean showing the
   * reviewer a claim no server made.
   */
  sensitivityClass: ReviewerSensitivityClass;
  allegationCodes: readonly TaxonomyCode[];
  /** Whether the reviewer has consented to sensitive material in this category. */
  consented: boolean;
  children: React.ReactNode;
}

export function SensitiveGate({
  sensitivityClass,
  allegationCodes,
  consented,
  children,
}: SensitiveGateProps) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);

  if (!revealed) {
    return (
      <View className="gap-3 rounded-lg border border-border bg-muted p-4">
        <Text className="text-base font-semibold text-foreground">{t('review.sensitive.title')}</Text>
        <View className="gap-1">
          <Text className="text-sm text-muted-foreground">
            {t(`sensitivity.${sensitivityClass}`)}
          </Text>
          {allegationCodes.map((code) => (
            <Text key={code} className="text-sm text-muted-foreground">
              {t(`taxonomy.${code}`, { defaultValue: code })}
            </Text>
          ))}
        </View>
        {consented ? (
          <>
            <Text className="text-sm leading-5 text-muted-foreground">
              {t('review.sensitive.body')}
            </Text>
            <Button variant="secondary" onPress={() => setRevealed(true)}>
              {t('review.sensitive.reveal')}
            </Button>
          </>
        ) : (
          <Text className="text-sm leading-5 text-muted-foreground">
            {t('review.sensitive.noConsent')}
          </Text>
        )}
      </View>
    );
  }

  return (
    <View className="gap-3">
      {children}
      <Button variant="ghost" size="small" onPress={() => setRevealed(false)}>
        {t('review.sensitive.hide')}
      </Button>
    </View>
  );
}
