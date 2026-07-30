/**
 * Renders one piece of case material.
 *
 * Four rules are load-bearing here:
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
 *  - **Nothing is silently dropped.** The switch is exhaustive over the contract's
 *    resource union, so a type this build cannot render richly still SAYS so, and
 *    a type added upstream is a compile error rather than a blank space. A jury
 *    judging material it was never shown is worse than a jury told plainly that a
 *    resource exists and could not be displayed — which is what
 *    `content_unavailable` and recusal are for.
 */

import type { ReviewerResource } from '@oxyhq/crowdsource-contracts';
import { Image } from 'expo-image';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { useImageResolver } from '@oxyhq/bloom/image-resolver';

interface ResourceViewProps {
  resource: ReviewerResource;
}

export function ResourceView({ resource }: ResourceViewProps) {
  const { t } = useTranslation();

  const unsupported = (kind: string): string =>
    t('review.resource.unsupported', {
      kind: t(`review.resource.kind.${kind}`, { defaultValue: kind }),
    });

  switch (resource.type) {
    case 'text':
      return <MaterialText text={resource.data.text} />;

    case 'image':
      return (
        <ResourceImage
          asset={resource.asset}
          label={t('review.resource.imageAlt')}
          unresolved={t('review.resource.unresolved')}
          unavailable={t('review.resource.unavailable')}
        />
      );

    case 'link':
      return (
        <View className="select-none gap-1 rounded-md border border-border bg-background p-4">
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('review.resource.linkLabel')}
          </Text>
          <Text className="font-bloom-mono text-sm text-foreground" selectable={false}>
            {resource.data.url}
          </Text>
          {resource.data.title === undefined ? null : <MaterialText text={resource.data.title} />}
          {resource.data.snapshot === undefined ? null : (
            <MaterialText text={resource.data.snapshot} />
          )}
          <Text className="text-xs leading-4 text-muted-foreground">
            {t('review.resource.linkNotOpened')}
          </Text>
        </View>
      );

    case 'document':
      return (
        <View className="gap-2">
          <MaterialText text={resource.data.title} />
          {resource.data.extractedText === undefined ? null : (
            <MaterialText text={resource.data.extractedText} />
          )}
          <UnrenderableResource label={unsupported(resource.type)} />
        </View>
      );

    case 'audio':
      return (
        <View className="gap-2">
          {resource.data?.transcript === undefined ? null : (
            <MaterialText text={resource.data.transcript} />
          )}
          <UnrenderableResource label={unsupported(resource.type)} />
        </View>
      );

    case 'profile':
      return (
        <View className="gap-1">
          {/* The display name and bio of the reported account — case material, and
              what the report was about. §9.1 hides who the author IS; nothing here
              is resolved against any identity. */}
          {resource.data.displayName === undefined ? null : (
            <MaterialText text={resource.data.displayName} />
          )}
          {resource.data.bio === undefined ? null : <MaterialText text={resource.data.bio} />}
        </View>
      );

    case 'listing':
      return (
        <View className="gap-1">
          <MaterialText text={resource.data.title} />
          {resource.data.description === undefined ? null : (
            <MaterialText text={resource.data.description} />
          )}
          {resource.data.price === undefined || resource.data.currency === undefined ? null : (
            <Text className="text-sm text-muted-foreground">
              {t('review.resource.listingPrice', {
                price: resource.data.price,
                currency: resource.data.currency,
              })}
            </Text>
          )}
        </View>
      );

    case 'location':
      return (
        <View className="gap-1 rounded-md border border-border bg-background p-4">
          {resource.data.label === undefined ? null : (
            <Text className="text-base leading-6 text-foreground" selectable={false}>
              {resource.data.label}
            </Text>
          )}
          {resource.data.latitude === undefined || resource.data.longitude === undefined ? null : (
            /* Coarse by contract — at most two decimal places, ≈1.1 km — which is
               what makes showing it compatible with §13.5's redaction rule. */
            <Text className="text-sm text-muted-foreground">
              {t('review.resource.coarseLocation', {
                latitude: resource.data.latitude,
                longitude: resource.data.longitude,
              })}
            </Text>
          )}
        </View>
      );

    case 'conversation':
      return (
        <UnrenderableResource
          label={t('review.resource.conversation', {
            count: resource.data.messageResourceIds.length,
          })}
        />
      );

    case 'video':
    case 'metadata':
    case 'custom':
      return <UnrenderableResource label={unsupported(resource.type)} />;

    default: {
      /**
       * A resource type the contract has and this screen does not.
       *
       * `never` rather than a silent fallback, so adding a resource type upstream
       * is a compile error here. A default branch that quietly rendered nothing is
       * how a jury ends up judging material one of its members never saw.
       */
      const unhandled: never = resource;
      throw new Error(`No renderer for a resource of this type: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Case material as text: never selectable, never cached, never logged. */
function MaterialText({ text }: { text: string }) {
  return (
    <View className="select-none rounded-md border border-border bg-background p-4">
      <Text className="text-base leading-6 text-foreground" selectable={false}>
        {text}
      </Text>
    </View>
  );
}

interface ResourceImageProps {
  asset: Extract<ReviewerResource, { type: 'image' }>['asset'];
  label: string;
  unresolved: string;
  unavailable: string;
}

function ResourceImage({ asset, label, unresolved, unavailable }: ResourceImageProps) {
  const resolveImage = useImageResolver();

  /**
   * `retrievable: false` means CrowdSource cannot serve these bytes — a url-backed
   * asset whose location is on the reporting application's own host, which §9.1
   * keeps off this screen. Saying so is the point: the jury has to know the
   * material existed, which is why `content_unavailable` is one of the four
   * outcomes a reviewer may return.
   */
  if (!asset.retrievable || asset.fileId === undefined) {
    return <UnrenderableResource label={unavailable} />;
  }

  // The one media chokepoint: bare file id in, URL out, resolved by the
  // ImageResolver registered at the app root. No per-screen URL helper, no
  // hardcoded host.
  const uri = resolveImage?.(asset.fileId);
  if (!uri) {
    return <UnrenderableResource label={unresolved} />;
  }
  return (
    <View className="aspect-video w-full overflow-hidden rounded-md border border-border bg-background">
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        cachePolicy="none"
        accessibilityLabel={label}
      />
    </View>
  );
}

function UnrenderableResource({ label }: { label: string }) {
  return (
    <View className="rounded-md border border-dashed border-border bg-muted p-4">
      <Text className="text-sm text-muted-foreground">{label}</Text>
    </View>
  );
}
