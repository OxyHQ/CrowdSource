/**
 * A single-select row of filter chips.
 *
 * Single-select and not multi-select because the API's `status` parameter takes one
 * value, and an unrecognised or repeated one is a 400. A multi-select control that
 * quietly sent the first of three selections would be lying about what the table is
 * showing — and reading a filtered table as the whole table is the specific
 * misreading §10.9's dead-letter view cannot afford.
 *
 * "All" is a real option rather than the absence of one: an operator has to be able
 * to see that no filter is applied.
 */

import { Chip } from '@oxyhq/bloom/chip';
import React from 'react';
import { Text, View } from 'react-native';

export interface FilterOption {
  /** The API value, or null for "no filter". */
  value: string | null;
  /** Already-localized label. */
  label: string;
  /** Optional count shown after the label. */
  count?: number;
}

interface FilterChipsProps {
  /** Already-localized name of what is being filtered, for screen readers. */
  label: string;
  options: FilterOption[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}

export function FilterChips({ label, options, selected, onSelect }: FilterChipsProps) {
  return (
    <View className="flex-row flex-wrap items-center gap-2" accessibilityLabel={label}>
      <Text className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Text>
      {options.map((option) => (
        <Chip
          key={option.value ?? 'all'}
          size="small"
          variant={option.value === selected ? 'solid' : 'outlined'}
          color={option.value === selected ? 'primary' : 'default'}
          selected={option.value === selected}
          onPress={() => onSelect(option.value)}
        >
          {option.count === undefined ? option.label : `${option.label} · ${option.count}`}
        </Chip>
      ))}
    </View>
  );
}
