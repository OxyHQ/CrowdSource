/**
 * The console's table.
 *
 * A header row of column titles over rows of cells, and nothing else — no sorting,
 * no column reordering, no row selection. Every list this app renders is already
 * ordered by the server (newest first, oldest revision first) and filtered by the
 * server, and a client-side sort over one page of a cursor-paged collection sorts
 * the page rather than the collection, which is a table that says something untrue.
 *
 * ## Why it is a flex layout and not a `<table>`
 *
 * react-native-web renders `View` as a `div`; there is no RN primitive that emits
 * table semantics. Rather than fight that, each row is a flex row and the header is
 * one too, with the SAME column widths driving both — so the columns line up
 * because they are the same numbers, not because two layouts happen to agree.
 * `accessibilityRole` marks the structure for assistive technology.
 *
 * ## Overflow is the table's own problem
 *
 * A delivery row carries eight columns and does not fit a narrow window. The
 * horizontal scroll goes on THIS container (`web:overflow-x-auto` plus a minimum
 * width derived from the columns), never on the document: `global.css` explains why
 * an `overflow` on `html`/`body` promotes the other axis and steals the page's
 * scroll.
 *
 * The header row is deliberately NOT sticky. Several screens render two or three
 * tables, and a sticky header per table would stack them up under the screen's own
 * sticky chrome, three tiers deep, with rows sliding between them.
 */

import React, { type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';

export interface Column<T> {
  /** Stable key for React, and the column's identity in the header row. */
  id: string;
  /** Already-localized column title. */
  header: string;
  /**
   * Fixed width in px, for a column whose content has a known size (a status
   * pill, a count, a timestamp). Mutually exclusive with `flex`.
   */
  width?: number;
  /** Share of the remaining space, for a column of variable-length text. */
  flex?: number;
  /** Right-aligned for numbers, so digits line up column-wise. */
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
}

/**
 * Minimum width a flexible column is given before the table starts scrolling.
 *
 * Without a floor, five flexible columns in a 400px window each get 80px and every
 * cell wraps to four lines. Scrolling sideways is the better failure.
 */
const FLEX_COLUMN_MIN_WIDTH = 140;

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /** Stable identity per row. Never an array index: rows are re-fetched. */
  keyOf: (row: T) => string;
  /** Already-localized empty-state copy. An empty table is a normal answer. */
  emptyTitle: string;
  emptyDescription?: string;
  /** Rendered inside the empty state when there is something to do about it. */
  emptyAction?: ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  keyOf,
  emptyTitle,
  emptyDescription,
  emptyAction,
}: DataTableProps<T>) {
  const minWidth = columns.reduce(
    (total, column) => total + (column.width ?? FLEX_COLUMN_MIN_WIDTH),
    0,
  );

  if (rows.length === 0) {
    return (
      <View className="rounded-lg border border-border">
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
      </View>
    );
  }

  return (
    <View className="rounded-lg border border-border web:overflow-x-auto">
      <View style={{ minWidth }}>
        <View
          className="flex-row items-center gap-3 border-b border-border bg-muted px-3 py-2"
          accessibilityRole="header"
        >
          {columns.map((column) => (
            <Text
              key={column.id}
              className={cn(
                'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
                column.align === 'right' && 'text-right',
              )}
              style={cellStyle(column)}
              numberOfLines={1}
            >
              {column.header}
            </Text>
          ))}
        </View>

        {rows.map((row, index) => (
          <View
            key={keyOf(row)}
            className={cn(
              'flex-row items-center gap-3 px-3 py-2',
              // A separator between rows but not after the last one, so the
              // table's own bottom border is the only line at the bottom.
              index < rows.length - 1 && 'border-b border-border',
            )}
          >
            {columns.map((column) => (
              <View
                key={column.id}
                className={cn(column.align === 'right' && 'items-end')}
                style={cellStyle(column)}
              >
                {column.render(row)}
              </View>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

/** The one place a column's width becomes a style, so header and body agree. */
function cellStyle<T>(column: Column<T>): { width: number } | { flex: number; minWidth: number } {
  return column.width === undefined
    ? { flex: column.flex ?? 1, minWidth: FLEX_COLUMN_MIN_WIDTH }
    : { width: column.width };
}

/** A cell of ordinary text. */
export function Cell({ children, muted = false }: { children: string; muted?: boolean }) {
  return (
    <Text
      className={cn('text-sm', muted ? 'text-muted-foreground' : 'text-foreground')}
      numberOfLines={1}
    >
      {children}
    </Text>
  );
}

/**
 * A cell holding an identifier.
 *
 * Monospaced and selectable for the same reason as `Identifier`: these are strings
 * an operator copies into a log query, and a proportional font makes `0`/`O`
 * indistinguishable exactly there. Truncated to one line — the full value is still
 * what gets selected and copied.
 */
export function IdentifierCell({ children }: { children: string }) {
  return (
    <Text className="font-bloom-mono text-xs text-foreground" numberOfLines={1} selectable>
      {children}
    </Text>
  );
}
