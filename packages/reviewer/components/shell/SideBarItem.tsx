/**
 * One row of the rail (and of the drawer, which is the same rail widened).
 *
 * Collapsed it is a 26px glyph in a circular hit target; expanded it grows a
 * label beside it. Selection reads three ways at once — a tinted pill behind the
 * row, the glyph in the primary colour and a heavier label — because at 60px
 * wide the pill is the only one of the three that is visible.
 */

import { useTheme } from '@oxyhq/bloom/theme';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

import type { ShellDestination } from '@/components/shell/navigation';
import { cn } from '@/lib/utils';

/**
 * Rendered glyph size (px). The row's icon box is 24px and the glyph overhangs
 * it by a pixel on each side, which is what gives the rail its weight.
 */
const ICON_SIZE = 26;

/** The shell's colour transition — 200ms on the same curve every rail row uses. */
const COLOR_TRANSITION = 'web:transition-colors web:duration-200 web:ease-[cubic-bezier(0.2,0,0,1)]';

interface SideBarItemProps {
  destination: ShellDestination;
  label: string;
  isActive: boolean;
  isExpanded: boolean;
  /** Called after navigating — the drawer closes itself this way. */
  onNavigate?: () => void;
}

export const SideBarItem = React.memo(function SideBarItem({
  destination,
  label,
  isActive,
  isExpanded,
  onNavigate,
}: SideBarItemProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const [isHovered, setIsHovered] = useState(false);

  const isHighlighted = isActive || isHovered;
  const Icon = destination.icon;

  const handlePress = useCallback(() => {
    onNavigate?.();
    // Every destination here is a tab root, so `navigate` pops to the existing
    // instance instead of stacking a second copy of a screen the reviewer is
    // already on.
    router.navigate(destination.href);
  }, [destination.href, onNavigate, router]);

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityState={{ selected: isActive }}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      className={cn(
        'mb-1.5 flex-row items-center rounded-[35px] py-2.5',
        isExpanded ? 'w-full self-stretch px-4' : 'self-center px-3',
        isActive && 'bg-primary/10',
        isHovered && !isActive && 'bg-primary/5',
        'active:bg-primary/13',
        COLOR_TRANSITION,
        'web:cursor-pointer',
      )}
    >
      <View
        className={cn(
          'w-full flex-row items-center',
          isExpanded ? 'justify-start gap-3' : 'justify-center gap-0',
        )}
      >
        {/*
         * The glyph takes its colour through a different channel per platform,
         * because react-native-svg has no CSS cascade of its own. On WEB the
         * wrapper's `text-*` class sets `color`, the glyph paints
         * `currentColor`, and the wrapper's transition carries the tint change
         * over the same 200ms the label takes. On NATIVE there is nothing to
         * inherit from, so the resolved token goes straight onto the glyph.
         */}
        <View
          className={cn(
            'h-6 w-6 items-center justify-center',
            isHighlighted ? 'text-primary' : 'text-foreground',
            COLOR_TRANSITION,
          )}
        >
          <Icon
            width={ICON_SIZE}
            height={ICON_SIZE}
            fill={
              Platform.OS === 'web'
                ? 'currentColor'
                : isHighlighted
                  ? colors.primary
                  : colors.text
            }
          />
        </View>
        {isExpanded ? (
          <Text
            className={cn(
              'text-[15px]',
              isActive ? 'font-semibold' : 'font-medium',
              isHighlighted ? 'text-primary' : 'text-foreground',
              COLOR_TRANSITION,
            )}
            numberOfLines={1}
          >
            {label}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
});
