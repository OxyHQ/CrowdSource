/**
 * The signed-in reviewer's own Oxy reputation, in the rail.
 *
 * Three things about this are deliberate and none should be relaxed.
 *
 * **It is only ever your own.** The balance is read for the signed-in user id
 * and no other, and this widget takes no subject prop, so there is no shape of
 * call site that could point it at somebody else. PLAN §9.1 keeps every other
 * person's reputation out of a reviewer's view entirely, and §8.4 is why: a
 * figure buys more invitations, never a louder vote. A rail that could show
 * another reviewer's standing would be a leaderboard, which this product does
 * not have.
 *
 * **Empty is the normal case, not a failure.** Reputation replaced karma
 * recently and almost nothing has been earned against it yet — in practice
 * essentially every reviewer's balance is untouched today. So a zero total is
 * not "0 points", which reads as a score you are losing at; it says nothing has
 * been recorded yet, which is true and is nobody's fault.
 *
 * **It reads only `total` and `trustTier`.** The API returns the full balance
 * (breakdown, influence, reliability) to the SUBJECT of the balance and to
 * staff, but a non-owner gets only `userId`, `total` and `trustTier`. Rendering
 * from the two fields that survive in both shapes means this cannot break, or
 * quietly show a stale zero, if it is ever pointed anywhere else.
 */

import { Growth_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import { Loading } from '@oxyhq/bloom/loading';
import { useAuth } from '@oxyhq/services/ui/client';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { BaseWidget } from '@/components/widgets/BaseWidget';
import { createScopedLogger } from '@/lib/logger';
import { oxyServices } from '@/lib/oxyServices';
import { reviewerQueryKeys } from '@/lib/reviewer-api/query-keys';
import { useReviewerViewer } from '@/lib/reviewer-api/use-reviewer-viewer';

const logger = createScopedLogger('ReputationWidget');

/** Cache key placeholder while cold boot has not resolved the viewer yet. */
const UNRESOLVED_VIEWER_KEY = 'unresolved';

/** Reputation moves slowly and this is ambient. Five minutes. */
const STALE_TIME_MS = 5 * 60 * 1000;

export function ReputationWidget({ divider }: { divider?: boolean }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const viewer = useReviewerViewer();
  const userId = user?.id;

  const balanceQuery = useQuery({
    queryKey: reviewerQueryKeys.reputation(viewer.key ?? UNRESOLVED_VIEWER_KEY),
    // Gated on the same signal as every other private read: `isAuthenticated`
    // alone is not enough, because a session can be committed a moment before
    // its access token is, and a request sent in that window comes back 401.
    enabled: viewer.canQuery && Boolean(userId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      if (!userId) {
        throw new Error('reputation requested without a signed-in user');
      }
      return oxyServices.getReputationBalance(userId);
    },
  });

  // Signed out, or cold boot still running: the rail shows nothing rather than
  // a placeholder for a figure that may never be asked for.
  if (!viewer.canQuery) {
    return null;
  }

  if (balanceQuery.isPending) {
    return (
      <BaseWidget title={t('rightBar.reputation.title')} divider={divider}>
        <Loading variant="skeleton" lines={2} />
      </BaseWidget>
    );
  }

  if (balanceQuery.error) {
    // Ambient, not load-bearing: nothing a reviewer does depends on this
    // number, so a failure to read it must not put an error in the corner of
    // every screen. Recorded rather than swallowed, and the rail simply omits
    // the widget.
    logger.warn('Could not read the reviewer reputation balance', {
      error: balanceQuery.error,
    });
    return null;
  }

  const balance = balanceQuery.data;
  if (!balance) {
    return null;
  }

  const hasEarned = balance.total !== 0;

  return (
    <BaseWidget title={t('rightBar.reputation.title')} divider={divider}>
      <View className="gap-2">
        {hasEarned ? (
          <View className="flex-row items-baseline gap-2">
            <Text className="text-2xl font-bold text-foreground">{balance.total}</Text>
            <Text className="text-sm text-muted-foreground">
              {t('rightBar.reputation.points')}
            </Text>
          </View>
        ) : (
          <View className="flex-row items-center gap-2">
            <Growth_Stroke2_Corner0_Rounded
              width={20}
              height={20}
              fill="currentColor"
              className="text-muted-foreground"
            />
            <Text className="flex-1 text-sm leading-5 text-muted-foreground">
              {t('rightBar.reputation.none')}
            </Text>
          </View>
        )}

        <Text className="text-sm text-muted-foreground">
          {t('rightBar.reputation.tier', {
            tier: t(`trustTier.${balance.trustTier}`, { defaultValue: balance.trustTier }),
          })}
        </Text>

        <Text className="text-xs leading-4 text-muted-foreground">
          {t('rightBar.reputation.help')}
        </Text>
      </View>
    </BaseWidget>
  );
}
