/**
 * PLAN §13.8 — a pseudonymous, per-assignment watermark over the case material.
 *
 * The label is issued by the server with the assignment and is never synthesized
 * on the device: the point is that a leaked screenshot can be traced back to the
 * assignment that produced it, which only works if the server knows what it
 * stamped. When the server sends no watermark, none is drawn — an invented one
 * would be traceable to nothing while looking exactly as if it were.
 *
 * §13.8 is explicit that screenshots cannot be prevented on every device and
 * that the product must not claim otherwise. The reviewer is told what this is,
 * in `review.watermark.note`, rather than being given a false sense of a sealed
 * room.
 */

import React from 'react';
import { Text, View } from 'react-native';

interface WatermarkedMaterialProps {
  /** Server-issued pseudonymous label, or null when the server sent none. */
  label: string | null;
  children: React.ReactNode;
}

const WATERMARK_ROWS = [0, 1, 2, 3, 4, 5];

export function WatermarkedMaterial({ label, children }: WatermarkedMaterialProps) {
  if (!label) {
    return <>{children}</>;
  }

  return (
    <View className="relative overflow-hidden">
      {children}
      {/*
       * `pointerEvents` is set as a prop rather than a class: it must hold on
       * every platform even if the utility class fails to compile, and an
       * overlay that swallows taps would make the material unusable.
       */}
      <View
        pointerEvents="none"
        className="absolute inset-0 items-center justify-around overflow-hidden"
      >
        {WATERMARK_ROWS.map((row) => (
          <Text
            key={row}
            selectable={false}
            className="-rotate-12 text-xs font-semibold uppercase tracking-widest text-foreground opacity-10"
          >
            {label}
          </Text>
        ))}
      </View>
    </View>
  );
}
