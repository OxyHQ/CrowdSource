/**
 * Onboarding and consent (PLAN §4.1, §8.1, §8.2).
 *
 * What the system is, what the rules are, an age confirmation, the languages and
 * categories this person is willing to work in, and explicit consent for
 * sensitive material — per category, and revocable from the wellbeing screen at
 * any time afterwards (§13.7).
 *
 * Completing this does not make anyone a juror. It moves an `applicant` to
 * `calibrating`, where their answers train them and decide nothing (§8.1).
 */

import { Button } from '@oxyhq/bloom/button';
import { Checkbox } from '@oxyhq/bloom/checkbox';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice } from '@/components/ApiStateNotice';
import { Panel, Screen } from '@/components/Screen';
import { SUPPORTED_LANGUAGES } from '@/lib/constants';
import { useCompleteOnboarding } from '@/lib/reviewer-api/queries';
import { CONSENTABLE_FAMILIES, OPT_IN_FAMILIES } from '@/lib/taxonomy';

const RULES = [
  'noChoosing',
  'blind',
  'oneVote',
  'recusalFree',
  'confidential',
  'noSharing',
] as const;

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export default function OnboardingScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const completeOnboarding = useCompleteOnboarding();

  const [acceptRules, setAcceptRules] = useState(false);
  const [confirmAge, setConfirmAge] = useState(false);
  const [languages, setLanguages] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [sensitiveCategories, setSensitiveCategories] = useState<string[]>([]);

  const complete = acceptRules && confirmAge && languages.length > 0 && categories.length > 0;

  const handleSubmit = () => {
    if (!complete) {
      return;
    }
    completeOnboarding.mutate(
      {
        acceptRules,
        confirmAge,
        languages,
        categories,
        // Consent can only be given for a category the reviewer actually took,
        // so a category dropped above cannot leave a stray consent behind.
        sensitiveCategories: sensitiveCategories.filter((family) => categories.includes(family)),
      },
      { onSuccess: () => router.replace('/') },
    );
  };

  return (
    <Screen title={t('onboarding.title')}>
      <Text className="text-base leading-6 text-muted-foreground">{t('onboarding.subtitle')}</Text>

      <Panel title={t('onboarding.what.title')} description={t('onboarding.what.body')} />

      <Panel title={t('onboarding.rules.title')} description={t('onboarding.rules.help')}>
        <View className="gap-2">
          {RULES.map((rule) => (
            <Text key={rule} className="text-sm leading-5 text-foreground">
              {t(`onboarding.rule.${rule}`)}
            </Text>
          ))}
        </View>
        <Checkbox
          checked={acceptRules}
          onCheckedChange={setAcceptRules}
          label={t('onboarding.rules.accept')}
        />
      </Panel>

      <Panel title={t('onboarding.age.title')} description={t('onboarding.age.help')}>
        <Checkbox
          checked={confirmAge}
          onCheckedChange={setConfirmAge}
          label={t('onboarding.age.confirm')}
        />
      </Panel>

      <Panel title={t('onboarding.languages.title')} description={t('onboarding.languages.help')}>
        {SUPPORTED_LANGUAGES.map((language) => (
          <Checkbox
            key={language}
            checked={languages.includes(language)}
            onCheckedChange={() => setLanguages((current) => toggle(current, language))}
            label={t(`language.${language}`)}
          />
        ))}
      </Panel>

      <Panel title={t('onboarding.categories.title')} description={t('onboarding.categories.help')}>
        {OPT_IN_FAMILIES.map((family) => (
          <Checkbox
            key={family.id}
            checked={categories.includes(family.id)}
            onCheckedChange={() => setCategories((current) => toggle(current, family.id))}
            label={t(`category.${family.id}`)}
            description={t(`category.${family.id}.help`)}
          />
        ))}
        <Text className="text-xs leading-4 text-muted-foreground">
          {t('onboarding.categories.specialistNote')}
        </Text>
      </Panel>

      <Panel title={t('onboarding.sensitive.title')} description={t('onboarding.sensitive.help')}>
        {CONSENTABLE_FAMILIES.map((family) => (
          <Checkbox
            key={family.id}
            checked={sensitiveCategories.includes(family.id)}
            onCheckedChange={() =>
              setSensitiveCategories((current) => toggle(current, family.id))
            }
            disabled={!categories.includes(family.id)}
            label={t(`category.${family.id}`)}
            description={
              categories.includes(family.id)
                ? t('onboarding.sensitive.consentHelp')
                : t('onboarding.sensitive.needsCategory')
            }
          />
        ))}
        <Text className="text-xs leading-4 text-muted-foreground">
          {t('onboarding.sensitive.revocable')}
        </Text>
      </Panel>

      {completeOnboarding.error ? <ApiStateNotice error={completeOnboarding.error} /> : null}

      <Button
        variant="primary"
        onPress={handleSubmit}
        disabled={!complete}
        loading={completeOnboarding.isPending}
      >
        {t('onboarding.action')}
      </Button>
    </Screen>
  );
}
