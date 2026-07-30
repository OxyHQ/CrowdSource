/**
 * Wellbeing (PLAN §4.1, §13.7).
 *
 * Consent is per category and can be withdrawn here at any time, without giving
 * a reason and without it counting against anything. Pausing assignments takes
 * one switch. The open case can be taken off the screen immediately, before any
 * network call, because "I need this gone now" must not wait on a round trip.
 *
 * The daily limit and the enforced break are shown as the reviewer's own
 * controls, not as quotas to hit.
 */

import { Button } from '@oxyhq/bloom/button';
import { Checkbox } from '@oxyhq/bloom/checkbox';
import { Switch } from '@oxyhq/bloom/switch';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { ChoiceRow } from '@/components/ChoiceRow';
import { Panel, Screen } from '@/components/Screen';
import { SUPPORTED_LANGUAGES } from '@/lib/constants';
import { useActiveAssignment } from '@/lib/reviewer-api/active-assignment';
import {
  useReviewerProfile,
  useStopShowingCase,
  useUpdatePreferences,
} from '@/lib/reviewer-api/queries';
import type {
  ReviewerPreferencesUpdate,
  ReviewerProfileView,
  TaxonomyFamily,
} from '@oxyhq/crowdsource-contracts';
import { CONSENTABLE_FAMILIES, OPT_IN_FAMILIES } from '@/lib/taxonomy';

const DAILY_LIMIT_OPTIONS = [5, 10, 20, 40];

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export default function WellbeingScreen() {
  const { t } = useTranslation();
  const profileQuery = useReviewerProfile();
  const activeAssignment = useActiveAssignment();
  const stopShowingCase = useStopShowingCase();
  const router = useRouter();

  return (
    <Screen title={t('wellbeing.title')}>
      <Text className="text-base leading-6 text-muted-foreground">{t('wellbeing.subtitle')}</Text>

      {activeAssignment ? (
        <Panel title={t('wellbeing.exit.title')} description={t('wellbeing.exit.body')}>
          <Button
            variant="secondary"
            onPress={() => {
              stopShowingCase();
              router.replace('/');
            }}
          >
            {t('wellbeing.exit.action')}
          </Button>
          <Text className="text-xs leading-4 text-muted-foreground">
            {t('wellbeing.exit.note')}
          </Text>
        </Panel>
      ) : null}

      {profileQuery.isPending ? <LoadingPanel /> : null}
      {profileQuery.error ? <ApiStateNotice error={profileQuery.error} /> : null}
      {profileQuery.data ? <WellbeingForm profile={profileQuery.data} /> : null}

      <Panel title={t('wellbeing.support.title')} description={t('wellbeing.support.body')} />
    </Screen>
  );
}

function WellbeingForm({ profile }: { profile: ReviewerProfileView }) {
  const { t } = useTranslation();
  const updatePreferences = useUpdatePreferences();

  // Seeded once, from the profile that had already loaded when this component
  // mounted. Our own save writes the server's answer straight into the query
  // cache, so there is no second source of truth to reconcile and no effect.
  /**
   * The draft is the app's own working shape, not the wire body.
   *
   * `sensitiveCategories` lives under `consent` on the profile and is called
   * `consentedSensitiveCategories` on the update, and `dailyLimit` is
   * `dailyReviewLimit` there. Keeping the draft in the names the CONTROLS use and
   * translating once, at save, is what stops a screen inventing a body shape —
   * which is what it was doing: three of the five keys it used to send were
   * refused outright by the strict preferences schema.
   */
  interface PreferencesDraft {
    languages: string[];
    categories: TaxonomyFamily[];
    sensitiveCategories: TaxonomyFamily[];
    dailyLimit: number;
    availableForAssignment: boolean;
  }

  const [draft, setDraft] = useState<PreferencesDraft>(() => ({
    languages: [...profile.preferences.languages],
    categories: [...profile.preferences.categories],
    sensitiveCategories: [...profile.consent.sensitiveCategories],
    dailyLimit: profile.preferences.dailyLimit,
    availableForAssignment: profile.preferences.availableForAssignment,
  }));

  const limitOptions = DAILY_LIMIT_OPTIONS.includes(draft.dailyLimit)
    ? DAILY_LIMIT_OPTIONS
    : [...DAILY_LIMIT_OPTIONS, draft.dailyLimit].sort((a, b) => a - b);

  const handleSave = () => {
    // Consent cannot outlive the category it belongs to.
    const consented = draft.sensitiveCategories.filter((family) =>
      draft.categories.includes(family),
    );
    const update: ReviewerPreferencesUpdate = {
      languages: draft.languages,
      categories: draft.categories,
      dailyReviewLimit: draft.dailyLimit,
      available: draft.availableForAssignment,
      consentedSensitiveCategories: consented,
      /**
       * §13.7's withdrawal has to move BOTH: the per-family list and the class
       * ceiling. Leaving the ceiling raised while the list is empty means the
       * draw refuses on `category_consent_missing` rather than on consent being
       * withdrawn, and dropping the ceiling while a family stays consented means
       * the draw refuses on `sensitivity_above_consent` — either way a reviewer
       * sees consent as granted and is never drawn, with nothing saying why.
       */
      maxSensitivity: consented.length > 0 ? 'sensitive' : 'standard',
    };
    updatePreferences.mutate(update);
  };

  return (
    <>
      <Panel title={t('wellbeing.availability.title')} description={t('wellbeing.availability.help')}>
        <View className="flex-row items-center justify-between gap-4">
          <Text className="flex-1 text-base text-foreground">
            {draft.availableForAssignment
              ? t('wellbeing.availability.on')
              : t('wellbeing.availability.off')}
          </Text>
          <Switch
            value={draft.availableForAssignment}
            onValueChange={(availableForAssignment) =>
              setDraft((current) => ({ ...current, availableForAssignment }))
            }
          />
        </View>
      </Panel>

      <Panel title={t('wellbeing.limit.title')} description={t('wellbeing.limit.help')}>
        {limitOptions.map((limit) => (
          <ChoiceRow
            key={limit}
            label={t('wellbeing.limit.option', { limit })}
            selected={draft.dailyLimit === limit}
            onSelect={() => setDraft((current) => ({ ...current, dailyLimit: limit }))}
          />
        ))}
        {profile.exposure.breakRequiredUntil ? (
          <Text className="text-sm text-muted-foreground">
            {t('reliability.exposure.break', {
              time: new Date(profile.exposure.breakRequiredUntil).toLocaleString(),
            })}
          </Text>
        ) : null}
      </Panel>

      <Panel title={t('wellbeing.categories.title')} description={t('wellbeing.categories.help')}>
        {OPT_IN_FAMILIES.map((family) => (
          <Checkbox
            key={family.id}
            checked={draft.categories.includes(family.id)}
            onCheckedChange={() =>
              setDraft((current) => ({
                ...current,
                categories: toggle(current.categories, family.id),
              }))
            }
            label={t(`category.${family.id}`)}
            description={t(`category.${family.id}.help`)}
          />
        ))}
      </Panel>

      <Panel title={t('wellbeing.consent.title')} description={t('wellbeing.consent.help')}>
        {CONSENTABLE_FAMILIES.map((family) => (
          <Checkbox
            key={family.id}
            checked={draft.sensitiveCategories.includes(family.id)}
            onCheckedChange={() =>
              setDraft((current) => ({
                ...current,
                sensitiveCategories: toggle(current.sensitiveCategories, family.id),
              }))
            }
            disabled={!draft.categories.includes(family.id)}
            label={t(`category.${family.id}`)}
            description={
              draft.categories.includes(family.id)
                ? t('wellbeing.consent.revocable')
                : t('onboarding.sensitive.needsCategory')
            }
          />
        ))}
      </Panel>

      <Panel title={t('wellbeing.languages.title')} description={t('wellbeing.languages.help')}>
        {SUPPORTED_LANGUAGES.map((language) => (
          <Checkbox
            key={language}
            checked={draft.languages.includes(language)}
            onCheckedChange={() =>
              setDraft((current) => ({
                ...current,
                languages: toggle(current.languages, language),
              }))
            }
            label={t(`language.${language}`)}
          />
        ))}
      </Panel>

      {updatePreferences.error ? <ApiStateNotice error={updatePreferences.error} /> : null}

      <Button variant="primary" onPress={handleSave} loading={updatePreferences.isPending}>
        {t('wellbeing.save')}
      </Button>
      {updatePreferences.isSuccess ? (
        <Text className="text-sm text-muted-foreground">{t('wellbeing.saved')}</Text>
      ) : null}
    </>
  );
}
