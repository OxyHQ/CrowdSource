/**
 * Recusal (PLAN §4.1, §13.7).
 *
 * A reviewer may hand a case back for a conflict, a language they do not really
 * read, material they do not want to look at today, or context they do not have.
 * None of it counts against them, and this screen is written to say so rather
 * than to test their resolve: one reason, an optional note, one button. No
 * confirmation dialog, no warning about consequences, no "are you sure".
 *
 * The reason IS required, but only because the sortition service needs to know
 * whether to redraw for language, for conflict or for exposure. The free-text
 * note is never required — nobody has to explain themselves to leave.
 */

import { Button } from '@oxyhq/bloom/button';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput } from 'react-native';

import { ApiStateNotice } from '@/components/ApiStateNotice';
import { ChoiceRow } from '@/components/ChoiceRow';
import { Panel, Screen } from '@/components/Screen';
import { useActiveAssignment } from '@/lib/reviewer-api/active-assignment';
import { useRecuseFromAssignment } from '@/lib/reviewer-api/queries';
import type { RecusalReason } from '@/lib/reviewer-api/types';

const RECUSAL_REASONS: readonly RecusalReason[] = [
  'conflict_of_interest',
  'language',
  'too_sensitive',
  'insufficient_context',
  'unavailable',
];

export default function RecuseScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const assignment = useActiveAssignment();
  const recuse = useRecuseFromAssignment();
  const [reason, setReason] = useState<RecusalReason | null>(null);
  const [notes, setNotes] = useState('');

  if (!assignment) {
    return (
      <Screen title={t('recuse.title')}>
        <Panel title={t('review.noCase.title')} description={t('review.noCase.body')}>
          <Button variant="secondary" onPress={() => router.replace('/')}>
            {t('review.noCase.action')}
          </Button>
        </Panel>
      </Screen>
    );
  }

  const handleRecuse = () => {
    if (reason === null) {
      return;
    }
    const trimmed = notes.trim();
    recuse.mutate(
      {
        assignmentId: assignment.assignmentId,
        recusal: { reason, ...(trimmed ? { notes: trimmed } : {}) },
      },
      { onSuccess: () => router.replace('/') },
    );
  };

  return (
    <Screen title={t('recuse.title')} subtitle={t('recuse.subtitle')}>
      <Panel description={t('recuse.reassurance')} />

      <Panel title={t('recuse.reason.title')} description={t('recuse.reason.help')}>
        {RECUSAL_REASONS.map((candidate) => (
          <ChoiceRow
            key={candidate}
            label={t(`recusalReason.${candidate}`)}
            description={t(`recusalReason.${candidate}.help`)}
            selected={reason === candidate}
            onSelect={() => setReason(candidate)}
          />
        ))}
      </Panel>

      <Panel title={t('recuse.notes.title')} description={t('recuse.notes.help')}>
        <TextInput
          className="min-h-[80px] rounded-md border border-border bg-background p-3 text-base text-foreground"
          multiline
          value={notes}
          onChangeText={setNotes}
          placeholder={t('recuse.notes.placeholder')}
          accessibilityLabel={t('recuse.notes.title')}
        />
      </Panel>

      {recuse.error ? <ApiStateNotice error={recuse.error} /> : null}

      <Button
        variant="primary"
        onPress={handleRecuse}
        disabled={reason === null}
        loading={recuse.isPending}
      >
        {t('recuse.action')}
      </Button>
      <Button variant="ghost" onPress={() => router.back()}>
        {t('recuse.cancel')}
      </Button>
    </Screen>
  );
}
