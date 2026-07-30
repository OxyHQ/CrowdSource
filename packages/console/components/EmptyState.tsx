/**
 * The shape an empty surface takes.
 *
 * Mention's `components/common/EmptyState.tsx`, subtracted: its icon comes from
 * Ionicons and it carries an error-with-retry branch, because Mention's empty
 * states are mostly failures to load. This app's are not. Errors here are
 * `ApiStateNotice`'s job — it names the endpoint being waited on — so this
 * component keeps only the empty case, and the icon comes from Bloom, which is
 * where every other glyph in this app comes from.
 *
 * The reason this exists at all: nothing in a reviewer's day is rarer than an
 * error and commoner than an absence. No case matched you. You have not
 * reviewed anything yet. Your standings are empty because you have not started.
 * Each of those is a NORMAL outcome of a system working correctly, and a line of
 * grey text under a button reads as a failure. An empty state that is composed —
 * a glyph, a title, a sentence — reads as an answer.
 */

import React, { type ReactNode } from 'react';
import { Text, View } from 'react-native';

interface EmptyStateProps {
  /**
   * The glyph. Passed in rather than named by a string prop so the caller picks
   * from Bloom's set directly and a typo is a type error.
   */
  icon?: ReactNode;
  title: string;
  /** One sentence saying why it is empty, in terms of what happens next. */
  description?: string;
  /** The one thing to do about it, when there is one. */
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <View
      className="items-center gap-3 px-6 py-10"
      accessibilityRole="summary"
      accessibilityLabel={description ? `${title}. ${description}` : title}
    >
      {icon ? (
        // A muted disc rather than a bare glyph: it gives the state a centre of
        // gravity at the size the surrounding panels have, so an empty screen
        // still reads as composed rather than as a page that failed to fill.
        <View className="h-16 w-16 items-center justify-center rounded-full bg-muted">{icon}</View>
      ) : null}
      <Text className="text-center text-base font-semibold text-foreground">{title}</Text>
      {description ? (
        <Text className="max-w-[320px] text-center text-sm leading-5 text-muted-foreground">
          {description}
        </Text>
      ) : null}
      {action ? <View className="pt-1">{action}</View> : null}
    </View>
  );
}
