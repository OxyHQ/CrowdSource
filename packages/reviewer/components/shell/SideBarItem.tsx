/**
 * One row of the rail (and of the drawer, which is the same rail widened).
 *
 * Collapsed it is a 24px glyph in a circular hit target; expanded it grows a
 * label beside it. Selection reads three ways at once — a tinted pill behind the
 * row, the glyph in the primary colour and a heavier label — because at 60px
 * wide the pill is the only one of the three that is visible.
 */

import { useTheme } from '@oxyhq/bloom/theme';
import { useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { ShellDestination } from '@/components/shell/navigation';
import { cn } from '@/lib/utils';

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
        'active:bg-primary/15',
        'web:transition-colors web:duration-200 web:cursor-pointer',
      )}
    >
      <View
        className={cn(
          'w-full flex-row items-center',
          isExpanded ? 'justify-start gap-3' : 'justify-center gap-0',
        )}
      >
        <View className="h-6 w-6 items-center justify-center">
          {/*
           * react-native-svg has no CSS cascade, so an icon takes its colour from
           * its own `fill` prop rather than from a `text-*` class on the wrapper.
           * These are the two theme tokens the classes below map to, resolved
           * once here so web and native tint identically.
           */}
          <Icon size="lg" fill={isHighlighted ? colors.primary : colors.text} />
        </View>
        {isExpanded ? (
          <Text
            className={cn(
              'text-[15px]',
              isActive ? 'font-semibold' : 'font-medium',
              isHighlighted ? 'text-primary' : 'text-foreground',
              'web:transition-colors web:duration-200',
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
