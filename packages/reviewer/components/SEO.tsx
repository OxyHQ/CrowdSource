/**
 * The document title, per screen.
 *
 * Mention's `components/SEO.tsx`, subtracted hard. Mention emits a full Open
 * Graph and Twitter card set because its pages are meant to be shared, indexed
 * and unfurled. **None of that may exist here.** A reviewer surface is not
 * shareable — PLAN §9.1 keeps the case and everything around it out of anything
 * public, and a case is never addressable in the first place. So there is no
 * `og:image`, no description, no canonical URL, and nothing that describes a
 * page's contents to a crawler.
 *
 * What survives is the one thing that is purely for the person using the app:
 * the browser tab and the window title, so a reviewer with the app open beside
 * their work can tell which surface it is on. Web only, and no case ever names
 * itself here — the review screen passes its own screen name, never anything
 * from the assignment.
 */

import ExpoHead from 'expo-router/head';
import React from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

interface SEOProps {
  /** The screen's name. Never case material, and never a case identifier. */
  title?: string;
}

export function SEO({ title }: SEOProps) {
  const { t } = useTranslation();

  // Native has no document to title, and `expo-router/head` is a no-op there.
  if (Platform.OS !== 'web') {
    return null;
  }

  const appName = t('app.name');

  return (
    <ExpoHead>
      <title>{title ? `${title} · ${appName}` : appName}</title>
      {/* A reviewer surface must never be indexed. There is nothing here a
          search engine should hold, and the app is only reachable with a
          session anyway — this is the belt to that pair of braces. */}
      <meta name="robots" content="noindex, nofollow" />
    </ExpoHead>
  );
}
