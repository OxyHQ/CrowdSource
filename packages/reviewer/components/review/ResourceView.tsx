/**
 * Renders one piece of case material.
 *
 * Three rules are load-bearing here:
 *
 *  - **Nothing is cached.** `expo-image` is given `cachePolicy="none"` so a
 *    reviewed image never lands in the device's image cache. React Native's own
 *    `Image` caches to disk by default on both platforms, which would put case
 *    material into device storage — an invariant, not a preference.
 *  - **Links are shown, never opened.** Following a reported URL from the
 *    reviewer's device would hand the reported site the reviewer's address and
 *    load whatever it wants to serve. The URL is displayed as text.
 *  - **Text is not selectable.** PLAN §13.8 asks that copying be made awkward
 *    where reasonable. It also says not to pretend leaks can be prevented, so
 *    this is a speed bump and is described as one.
 */

import { Image } from 'expo-image';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { useImageResolver } from '@oxyhq/bloom/image-resolver';

import type { ReviewResource } from '@/lib/reviewer-api/types';

interface ResourceViewProps {
  resource: ReviewResource;
}

export function ResourceView({ resource }: ResourceViewProps) {
  const { t } = useTranslation();
  const resolveImage = useImageResolver();

  if (resource.kind === 'text' && typeof resource.text === 'string') {
    return (
      <View className="select-none rounded-md border border-border bg-background p-4">
        <Text className="text-base leading-6 text-foreground" selectable={false}>
          {resource.text}
        </Text>
      </View>
    );
  }

  if (resource.kind === 'image' && resource.fileId) {
    // The one media chokepoint: bare file id in, URL out, resolved by the
    // ImageResolver registered at the app root. No per-screen URL helper, no
    // hardcoded host.
    const uri = resolveImage?.(resource.fileId);
    if (!uri) {
      return <UnrenderableResource label={t('review.resource.unresolved')} />;
    }
    return (
      <View className="aspect-video w-full overflow-hidden rounded-md border border-border bg-background">
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          cachePolicy="none"
          accessibilityLabel={t('review.resource.imageAlt')}
        />
      </View>
    );
  }

  if (resource.kind === 'link' && resource.url) {
    return (
      <View className="select-none gap-1 rounded-md border border-border bg-background p-4">
        <Text className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('review.resource.linkLabel')}
        </Text>
        <Text className="font-bloom-mono text-sm text-foreground" selectable={false}>
          {resource.url}
        </Text>
        <Text className="text-xs leading-4 text-muted-foreground">
          {t('review.resource.linkNotOpened')}
        </Text>
      </View>
    );
  }

  // Video, audio and file resources have no renderer in this build. Shipping a
  // player that has never been given a byte of real media would be a guess; the
  // reviewer is told plainly, and `insufficient_context` / recusal remain open.
  return (
    <UnrenderableResource
      label={t('review.resource.unsupported', {
        kind: t(`review.resource.kind.${resource.kind}`, { defaultValue: resource.kind }),
      })}
    />
  );
}

function UnrenderableResource({ label }: { label: string }) {
  return (
    <View className="rounded-md border border-dashed border-border bg-muted p-4">
      <Text className="text-sm text-muted-foreground">{label}</Text>
    </View>
  );
}
