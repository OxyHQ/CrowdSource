/**
 * A key/value detail block.
 *
 * The console's other primitive beside the table: a case, an application and a
 * decision are all read as a list of named facts rather than as prose. Two-column
 * on anything wider than a phone, stacked below that.
 *
 * The important part is `ABSENT`. A row whose value is `null` renders an em dash,
 * never an empty cell and never a zero — `evidenceIntegrity` and its siblings are
 * absent because nothing measures them yet, and a `0` there would report the worst
 * possible score for a signal that has never been taken.
 */

import React, { type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { ABSENT } from '@/lib/console-api/presentation';

export interface KeyValueRow {
  /** Already-localized label. */
  label: string;
  /**
   * The value. A `string` is rendered as text; `null` becomes an em dash; a node
   * is rendered as-is (a status pill, a monospaced id, a copy affordance).
   */
  value: ReactNode | string | null;
  /** One line explaining a value an operator would otherwise have to look up. */
  hint?: string;
}

export function KeyValueList({ rows }: { rows: KeyValueRow[] }) {
  return (
    <View className="gap-3">
      {rows.map((row) => (
        <View key={row.label} className="gap-1 sm:flex-row sm:items-start sm:gap-4">
          <Text className="w-full text-xs uppercase tracking-wide text-muted-foreground sm:w-[220px] sm:shrink-0">
            {row.label}
          </Text>
          <View className="shrink gap-0.5">
            {typeof row.value === 'string' || row.value === null || row.value === undefined ? (
              <Text className="text-sm text-foreground" selectable>
                {row.value === null || row.value === undefined || row.value === ''
                  ? ABSENT
                  : row.value}
              </Text>
            ) : (
              row.value
            )}
            {row.hint ? (
              <Text className="text-xs leading-4 text-muted-foreground">{row.hint}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}
