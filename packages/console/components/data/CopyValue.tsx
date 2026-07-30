/**
 * A value with a copy affordance.
 *
 * Every string this console shows that a person then has to USE somewhere else — a
 * service token, a rotated webhook secret, an application id going into an
 * environment variable, a delivery id going into a support thread — gets one of
 * these. Selecting monospaced text with a mouse and hoping the selection ended in
 * the right place is how a token acquires a trailing space and an integration fails
 * with an authentication error nobody can explain.
 *
 * The clipboard is reached through `navigator.clipboard`, which is the platform API
 * on the only platform this app ships to. It can legitimately be unavailable — an
 * insecure origin, a browser that refuses the permission — so the failure is
 * reported rather than swallowed, and the value stays on screen and selectable
 * either way. Nothing is logged but the outcome: the value is the secret.
 */

import { Button } from '@oxyhq/bloom/button';
import { toast } from '@oxyhq/bloom/toast';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('CopyValue');

interface CopyValueProps {
  value: string;
  /**
   * What is being copied, already localized. Used in the button's accessible
   * label and in the confirmation, because "Copied" alone is ambiguous on a screen
   * with four copyable values.
   */
  label: string;
  /** `block` gives the value its own framed row; `inline` keeps it in a table cell. */
  layout?: 'inline' | 'block';
}

export function CopyValue({ value, label, layout = 'inline' }: CopyValueProps) {
  const { t } = useTranslation();

  const handleCopy = useCallback(() => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      // Not a defect and not silent: the value is still selectable on screen.
      logger.warn('Clipboard is unavailable in this context', { label });
      toast.error(t('copy.unavailable'));
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => {
        toast.success(t('copy.copied', { label }));
      },
      (error: unknown) => {
        logger.warn('Clipboard write was refused', { label, error });
        toast.error(t('copy.failed'));
      },
    );
  }, [label, t, value]);

  return (
    <View
      className={
        layout === 'block'
          ? 'flex-row items-center justify-between gap-3 rounded-md bg-muted p-3'
          : 'flex-row items-center gap-2'
      }
    >
      <Text
        className="shrink font-bloom-mono text-xs text-foreground"
        selectable
        numberOfLines={layout === 'block' ? undefined : 1}
      >
        {value}
      </Text>
      <Button
        variant="secondary"
        size="small"
        onPress={handleCopy}
        accessibilityLabel={t('copy.action', { label })}
      >
        {t('copy.short')}
      </Button>
    </View>
  );
}
