/**
 * The document title, per screen.
 *
 * Only the title, and deliberately nothing else. There is no Open Graph, no
 * description, no canonical URL and no `og:image`, because nothing here is
 * shareable: every route needs a session, one half of the app needs a staff role,
 * and the URLs carry tenant application ids. `noindex, nofollow` is repeated here
 * as the belt to `public/index.html`'s braces.
 *
 * What the title IS for is the operator: a console tab beside the service they are
 * integrating should say which screen it is on. Never a case id and never a
 * tenant's name — a browser title lands in history, in screenshots and in shoulder
 * views.
 */

import ExpoHead from 'expo-router/head';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface SEOProps {
  /** The screen's name. Never an id, and never a tenant's own data. */
  title?: string;
}

export function SEO({ title }: SEOProps) {
  const { t } = useTranslation();
  const appName = t('app.name');

  return (
    <ExpoHead>
      <title>{title ? `${title} · ${appName}` : appName}</title>
      <meta name="robots" content="noindex, nofollow" />
    </ExpoHead>
  );
}
