/**
 * Page chrome shared by every console screen.
 *
 * A sticky header carrying the screen's name, an optional subtitle and an optional
 * action cluster, over a full-width column. The header does not move: this is a
 * surface of tables, and an operator scrolling one needs the title and the actions
 * to stay reachable. That is the one substantive difference from the reviewer
 * app's `Screen`, which slides its header away under the finger.
 *
 * `Panel` below is the app's only grouping primitive. There is no card component
 * and no elevation: `ContentPanel` already supplies the one surface, and a card on
 * a card is a rectangle you can only find by its border.
 */

import React, { type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { PageScroll } from '@/components/PageScroll';
import { SEO } from '@/components/SEO';
import { PANEL_HEADER_HEIGHT, PanelStickyHeader } from '@/components/shell/PanelChrome';

interface ScreenProps {
  /** The screen's name, in the header and in the browser tab. */
  title: string;
  /**
   * The header's second line: what this screen is for, or which application it is
   * showing. A `ReactNode` so a screen can put a status pill next to a name.
   */
  subtitle?: ReactNode;
  /** Buttons that belong to the screen as a whole, right-aligned in the header. */
  actions?: ReactNode;
  /**
   * A row pinned directly BELOW the header — filter chips, a paging control.
   *
   * It is part of the chrome rather than of the content because a filter that
   * scrolls out of view while its results are still on screen is how an operator
   * ends up reading a filtered table as the whole table.
   */
  toolbar?: ReactNode;
  children: ReactNode;
}

export function Screen({ title, subtitle, actions, toolbar, children }: ScreenProps) {
  return (
    <View className="flex-1">
      <SEO title={title} />

      {/*
       * The header row and the toolbar are inside ONE sticky element, not two stacked
       * ones. A second sticky layer has to be told how far down to pin, which is only
       * correct while the row above it is exactly the height it was assumed to be — and
       * a header with a subtitle is taller, so the toolbar would overlap it by the
       * difference. One block whose height is whatever its contents are cannot be
       * offset wrongly.
       */}
      <PanelStickyHeader>
        <View
          className="flex-row items-center justify-between gap-4 border-b border-border px-4 py-2"
          style={{ minHeight: PANEL_HEADER_HEIGHT }}
        >
          <View className="shrink">
            <Text className="text-lg font-bold text-foreground" numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? <View className="pt-0.5">{subtitle}</View> : null}
          </View>
          {actions ? <View className="shrink-0 flex-row items-center gap-2">{actions}</View> : null}
        </View>

        {toolbar ? (
          <View className="flex-row flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            {toolbar}
          </View>
        ) : null}
      </PanelStickyHeader>

      <PageScroll>
        <View className="w-full gap-6 px-4 py-4">{children}</View>
      </PageScroll>
    </View>
  );
}

interface PanelProps {
  title?: string;
  description?: string;
  /** Buttons belonging to this section rather than to the screen. */
  actions?: ReactNode;
  children?: ReactNode;
}

/** A bordered section. No fill: it sits on the panel's own `bg-card` surface. */
export function Panel({ title, description, actions, children }: PanelProps) {
  return (
    <View className="gap-3 rounded-lg border border-border p-4">
      {title || actions ? (
        <View className="flex-row items-start justify-between gap-4">
          <View className="shrink gap-1">
            {title ? (
              <Text className="text-base font-semibold text-card-foreground">{title}</Text>
            ) : null}
            {description ? (
              <Text className="text-sm leading-5 text-muted-foreground">{description}</Text>
            ) : null}
          </View>
          {actions ? <View className="shrink-0 flex-row items-center gap-2">{actions}</View> : null}
        </View>
      ) : description ? (
        <Text className="text-sm leading-5 text-muted-foreground">{description}</Text>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A monospaced identifier.
 *
 * Every id in this console is a ULID or a UUID an operator copies into a support
 * thread, a log query or a curl command, so it is selectable and it is monospaced —
 * a proportional font makes `0`/`O` and `1`/`l` indistinguishable in exactly the
 * string where that matters.
 */
export function Identifier({ children }: { children: string }) {
  return (
    <Text className="font-bloom-mono text-xs text-foreground" selectable>
      {children}
    </Text>
  );
}
