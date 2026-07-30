/**
 * One row of the rail.
 *
 * Adapted from the reviewer app's `SideBarItem`, minus two things. There is no
 * native branch cloning a resolved `color` onto the glyph — on web `currentColor`
 * resolves from the wrapper's `text-*` class, which is the whole mechanism. And the
 * pressed state is a NativeWind `active:` class rather than an inline
 * `hsla(var(--primary), …)`: Bloom's base tokens already resolve to a full colour,
 * so wrapping one in `hsla()` produces an invalid value that silently computes to
 * transparent.
 *
 * `router.navigate`, not `push`: every rail destination is a screen an operator
 * returns to repeatedly, and `push` would grow a history stack that takes ten
 * back-presses to escape.
 */

import { useRouter, type Href } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { cn } from '@/lib/utils';

interface SideBarItemProps {
  label: string;
  href: Href;
  isActive: boolean;
  /** The glyph, or null for a row that is a name rather than a destination. */
  icon?: React.ReactNode;
}

export const SideBarItem = React.memo(function SideBarItem({
  label,
  href,
  isActive,
  icon,
}: SideBarItemProps) {
  const router = useRouter();
  const [isHovered, setIsHovered] = useState(false);
  const isHighlighted = isActive || isHovered;

  const handlePress = useCallback(() => {
    router.navigate(href);
  }, [href, router]);

  return (
    <Pressable
      onPress={handlePress}
      onHoverIn={useCallback(() => setIsHovered(true), [])}
      onHoverOut={useCallback(() => setIsHovered(false), [])}
      accessibilityRole="link"
      accessibilityState={{ selected: isActive }}
      className={cn(
        'w-full flex-row items-center gap-2.5 rounded-md px-2.5 py-2 web:cursor-pointer',
        isActive && 'bg-primary/10',
        isHovered && !isActive && 'bg-primary/5',
        'active:bg-primary/15',
      )}
    >
      {icon ? (
        <View
          className={cn(
            'h-5 w-5 shrink-0 items-center justify-center',
            isHighlighted ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          {icon}
        </View>
      ) : null}
      <Text
        className={cn(
          'shrink text-sm',
          isActive ? 'font-semibold text-primary' : 'font-medium',
          isHighlighted ? 'text-primary' : 'text-foreground',
        )}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
});
