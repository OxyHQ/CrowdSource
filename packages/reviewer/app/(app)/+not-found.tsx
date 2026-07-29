/**
 * A route that does not exist.
 *
 * Inside the shell, with the app's own header, rather than a bare centred box:
 * a reviewer who mistypes a URL or follows a stale link should land somewhere
 * that is recognisably this app and still has the menu in it, not on a page that
 * looks like the session broke.
 *
 * "Does not exist" is also the honest wording for a guessed case URL. There is
 * no case address to get wrong — the server assigns, nobody browses — so this is
 * what one correctly resolves to.
 */

import { Button } from '@oxyhq/bloom/button';
import { MagnifyingGlassX_Stroke2_Corner0_Rounded } from '@oxyhq/bloom/icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/EmptyState';
import { Screen } from '@/components/Screen';

export default function NotFoundScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    // The header gets the short form and the empty state the sentence. Both
    // reading `notFound.title` said the same thing twice, one above the other,
    // and the sentence wrapped the header onto two lines to do it.
    <Screen title={t('notFound.heading')}>
      <EmptyState
        icon={
          <MagnifyingGlassX_Stroke2_Corner0_Rounded
            width={28}
            height={28}
            fill="currentColor"
            className="text-muted-foreground"
          />
        }
        title={t('notFound.title')}
        description={t('notFound.body')}
        action={
          // `replace`, not `push`: the route that got here is not one to go back
          // to, and Bloom's button carries the pressed and hover states a bare
          // `Link` never had.
          <Button variant="secondary" onPress={() => router.replace('/')}>
            {t('notFound.action')}
          </Button>
        }
      />
    </Screen>
  );
}
