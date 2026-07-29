/**
 * Home — the reviewer's standing, and the one door into a case.
 *
 * "Review next case" REQUESTS an assignment (PLAN §4.1). It does not open a
 * queue, it does not show what is waiting, and there is nothing on this screen
 * or anywhere else in the app that lets a person pick. The server decides which
 * case, or that there is none for this reviewer right now — which is an ordinary
 * answer, not a failure.
 */

import { Button } from '@oxyhq/bloom/button';
import { CircleCheck_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { useAuth } from '@oxyhq/services/ui/client';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { ApiStateNotice, LoadingPanel } from '@/components/ApiStateNotice';
import { EmptyState } from '@/components/EmptyState';
import { LogoIcon } from '@/components/LogoIcon';
import { Panel, Screen } from '@/components/Screen';
import { assignmentBlockers } from '@/lib/eligibility';
import { useActiveAssignment } from '@/lib/reviewer-api/active-assignment';
import { useRequestNextAssignment, useReviewerProfile } from '@/lib/reviewer-api/queries';
import type { ReviewerProfile } from '@/lib/reviewer-api/types';

export default function HomeScreen() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const profileQuery = useReviewerProfile();
  const activeAssignment = useActiveAssignment();

  // Oxy owns identity: render `displayName` directly and fall back to the
  // normalized handle when a profile has none. Never recompose a name locally.
  const displayName = user?.name?.displayName?.trim() || getNormalizedUserHandle(user) || '';

  return (
    // The mark, centred, and no title beside it — the rail and the bar already
    // name this screen, and this is the one place in the app the product signs
    // its own name. Every other surface uses the same header with a title in it.
    <Screen
      titlePosition="center"
      subtitle={<LogoIcon height={28} />}
      documentTitle={t('home.title')}
    >
      {/* Identity is body copy here rather than a header subtitle: the mark has
          that slot. It stays first, where it was. */}
      {displayName ? (
        <Text className="text-base leading-6 text-muted-foreground">
          {t('home.signedInAs', { name: displayName })}
        </Text>
      ) : null}

      <Panel description={t('home.rule')} />

      {activeAssignment ? <OpenCasePanel /> : null}

      {profileQuery.isPending ? <LoadingPanel /> : null}
      {profileQuery.error ? <ApiStateNotice error={profileQuery.error} /> : null}
      {profileQuery.data ? (
        <ReviewerStanding
          profile={profileQuery.data}
          hasOpenAssignment={activeAssignment !== null}
        />
      ) : null}
    </Screen>
  );
}

function OpenCasePanel() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <Panel title={t('home.openCase.title')} description={t('home.openCase.body')}>
      <Button variant="primary" onPress={() => router.push('/review')}>
        {t('home.openCase.action')}
      </Button>
    </Panel>
  );
}

interface ReviewerStandingProps {
  profile: ReviewerProfile;
  hasOpenAssignment: boolean;
}

function ReviewerStanding({ profile, hasOpenAssignment }: ReviewerStandingProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const requestAssignment = useRequestNextAssignment();
  const [noCaseAvailable, setNoCaseAvailable] = useState(false);

  const blockers = assignmentBlockers(profile, new Date());

  const handleRequest = () => {
    setNoCaseAvailable(false);
    requestAssignment.mutate(undefined, {
      onSuccess: (assignment) => {
        if (assignment) {
          router.push('/review');
        } else {
          // No case matches this reviewer's categories, languages, consent and
          // exposure headroom. An empty draw is a normal outcome.
          setNoCaseAvailable(true);
        }
      },
    });
  };

  return (
    <>
      <Panel title={t('home.state.title')} description={t(`reviewerState.${profile.state}`)}>
        <Text className="text-sm text-muted-foreground">
          {t('home.state.exposure', {
            reviewed: profile.exposure.reviewedToday,
            limit: profile.exposure.dailyLimit,
          })}
        </Text>
        {/* These were bare `Link`s styled to look like buttons. They are the
            thing to do next on this screen, and a `Link` gives no pressed state
            at all on a touch device — tapping one read as the app ignoring you.
            Bloom's text variant carries pressed, hover and focus. */}
        {profile.state === 'applicant' || profile.consent.rulesAcceptedAt === null ? (
          <Button variant="text" onPress={() => router.push('/onboarding')}>
            {t('home.state.startOnboarding')}
          </Button>
        ) : null}
        {profile.state === 'calibrating' ? (
          <Button variant="text" onPress={() => router.push('/training')}>
            {t('home.state.continueTraining')}
          </Button>
        ) : null}
      </Panel>

      <Panel title={t('home.request.title')} description={t('home.request.help')}>
        {blockers.length > 0 ? (
          <View className="gap-1">
            {blockers.map((blocker) => (
              <Text key={blocker} className="text-sm text-muted-foreground">
                {t(`blocker.${blocker}`)}
              </Text>
            ))}
          </View>
        ) : null}

        <Button
          variant="primary"
          onPress={handleRequest}
          disabled={blockers.length > 0 || hasOpenAssignment}
          loading={requestAssignment.isPending}
        >
          {t('home.request.action')}
        </Button>

        {/* An empty draw is not an error and must not look like one. It is the
            correct answer whenever nothing open matches this reviewer's
            categories, languages, consent and exposure headroom — a routine
            outcome of the system working, and the one a reviewer will meet most
            often. As a grey sentence under the button it read as the request
            having failed. */}
        {noCaseAvailable ? (
          <EmptyState
            icon={
              <CircleCheck_Stroke2_Corner0_Rounded
                width={28}
                height={28}
                fill="currentColor"
                className="text-muted-foreground"
              />
            }
            title={t('home.request.noCaseTitle')}
            description={t('home.request.noCase')}
          />
        ) : null}
      </Panel>

      {requestAssignment.error ? <ApiStateNotice error={requestAssignment.error} /> : null}
    </>
  );
}
