/**
 * The single-select row used by every question in the app.
 *
 * Multi-select uses Bloom's `Checkbox` directly (it already renders a label and
 * description); single-select has no equivalent, so this pairs Bloom's
 * `RadioIndicator` with Bloom's `Item` rather than growing an app-local control.
 */

import { Item } from '@oxyhq/bloom/item';
import { RadioIndicator } from '@oxyhq/bloom/radio-indicator';
import React from 'react';

interface ChoiceRowProps {
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

export function ChoiceRow({ label, description, selected, onSelect, disabled }: ChoiceRowProps) {
  return (
    <Item
      title={label}
      subtitle={description}
      leading={<RadioIndicator selected={selected} />}
      onPress={onSelect}
      disabled={disabled}
      selected={selected}
      accessibilityRole="radio"
      density="compact"
    />
  );
}
