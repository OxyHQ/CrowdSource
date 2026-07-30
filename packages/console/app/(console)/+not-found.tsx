/**
 * A route that does not exist.
 *
 * Inside the shell, with the rail still in it, rather than a bare centred box: an
 * operator who mistypes a URL or follows a stale link should land somewhere that is
 * recognisably this console and still has the navigation, not on a page that looks
 * like the session broke.
 *
 * "Does not exist" is also the honest wording for a guessed application URL, and it
 * says nothing more. An application id that belongs to another tenant answers 404
 * from the API for exactly the same reason this page says nothing about what might
 * have been there.
 */

import { Button } from '@oxyhq/bloom/button';
import { PageX_Stroke2_Corner0_Rounded_Large } from '@oxyhq/bloom/icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/EmptyState';
import { Screen } from '@/components/Screen';

/** Rendered size (px) of the glyph inside the empty state's disc. */
const NOT_FOUND_ICON_SIZE = 28;

export default function NotFoundScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <Screen title={t('notFound.heading')}>
      <EmptyState
        icon={
          <PageX_Stroke2_Corner0_Rounded_Large
            width={NOT_FOUND_ICON_SIZE}
            height={NOT_FOUND_ICON_SIZE}
            fill="currentColor"
            className="text-muted-foreground"
          />
        }
        title={t('notFound.title')}
        description={t('notFound.body')}
        action={
          // `replace`, not `push`: the route that got here is not one to go back to.
          <Button variant="secondary" onPress={() => router.replace('/')}>
            {t('notFound.action')}
          </Button>
        }
      />
    </Screen>
  );
}
