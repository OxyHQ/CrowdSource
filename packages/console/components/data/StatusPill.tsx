/**
 * A status, as a pill.
 *
 * The tone comes from `lib/console-api/presentation.ts`, which is where the one
 * product-critical mapping lives: `inconclusive` has its own tone and is never
 * drawn as `no_violation`. This component only turns a tone into Bloom tokens, so
 * a palette change happens in one place and cannot merge two meanings by accident.
 *
 * Bloom's `Chip` is the primitive. Its tone set (`default | primary | success |
 * warning | error | info`) carries no member meaning "no answer", so `unresolved` —
 * the absence of consensus — takes `default` with an outlined fill instead of a
 * colour: it is neither a good outcome nor a bad one, and any colour from that set
 * would claim it was one. That distinction is the reason this mapping is written
 * out rather than derived.
 */

import { Chip } from '@oxyhq/bloom/chip';
import type { AccentFill, AccentTone } from '@oxyhq/bloom/theme';
import React from 'react';

import type { Tone } from '@/lib/console-api/presentation';

const TONE_STYLE: Record<Tone, { color: AccentTone; variant: AccentFill }> = {
  neutral: { color: 'default', variant: 'subtle' },
  // The console's `info` is its own accent, not Bloom's informational blue: it
  // marks the state a reader should look at next, so it speaks in the app colour.
  info: { color: 'primary', variant: 'subtle' },
  positive: { color: 'success', variant: 'subtle' },
  caution: { color: 'warning', variant: 'subtle' },
  danger: { color: 'error', variant: 'subtle' },
  // Outlined, uncoloured: an unresolved case is not a warning and not a success.
  unresolved: { color: 'default', variant: 'outlined' },
};

interface StatusPillProps {
  /** Already-localized label. This component never translates. */
  label: string;
  tone: Tone;
}

export function StatusPill({ label, tone }: StatusPillProps) {
  const { color, variant } = TONE_STYLE[tone];
  return (
    <Chip size="small" color={color} variant={variant}>
      {label}
    </Chip>
  );
}
