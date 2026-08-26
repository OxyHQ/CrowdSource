/**
 * Honest states for a surface whose backend is not deployed yet.
 *
 * A screen that met an absent API with sample data would look finished and be a
 * lie — someone would demo it. So a screen that cannot load says which endpoint it
 * is waiting for, by name, and offers nothing else. When the endpoint ships, the
 * same screens light up with no change here.
 *
 * The other branches are not placeholders at all; they are the permanent copy for
 * states this console will keep having. A 403 is a seat too small or a role not
 * held, a 409 is the current state of the world, and a 404 on an application route
 * is the server's deliberate refusal to say whether it exists — which the console
 * repeats rather than resolving on the caller's behalf.
 *
 * ONE thing is never rendered here: an HTTP error's `message`. The API answers
 * `{ error: { code, message } }` and the shared SDK reduces that to the string
 * `"[object Object]"` (see `lib/console-api/errors.ts`), so printing it would put
 * that under a table. `MalformedPayloadError` is the exception, because its message
 * is written by this app and names the offending field path.
 */

import * as Skeleton from '@oxyhq/bloom/skeleton';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

import { Panel } from '@/components/Screen';
import { API_URL } from '@/config';
import {
  ConsoleApiUnavailableError,
  ConsoleConflictError,
  ConsoleForbiddenError,
  ConsoleRateLimitedError,
  ConsoleRequestRejectedError,
  ConsoleResourceMissingError,
  ConsoleServiceUnavailableError,
  MalformedPayloadError,
  isConsoleApiUnreachable,
} from '@/lib/console-api/errors';

/** Text lines the placeholder draws per panel, matching a typical panel's body. */
const PLACEHOLDER_LINES_PER_PANEL = 3;

/**
 * The placeholder a screen shows while its content is on the way.
 *
 * Shaped like what it replaces rather than like a spinner: every screen here
 * resolves into a short stack of bordered panels, so the placeholder is that stack
 * with its text greyed out. The page lands at roughly the height it will keep
 * instead of a centred spinner collapsing into a full table and shoving everything
 * down the page.
 */
export function LoadingPanel({ count = 2 }: { count?: number }) {
  const { t } = useTranslation();
  return (
    <View className="gap-6" accessibilityRole="progressbar" accessibilityLabel={t('state.loading')}>
      {Array.from({ length: count }, (_, index) => (
        <Panel key={index}>
          <View className="gap-2">
            {Array.from({ length: PLACEHOLDER_LINES_PER_PANEL }, (_, line) => (
              <Skeleton.Box key={line} width="100%" height={16} borderRadius={4} />
            ))}
          </View>
        </Panel>
      ))}
    </View>
  );
}

/** A labelled, selectable endpoint name — what a developer needs to act on. */
function EndpointDetail({ endpoint }: { endpoint: string }) {
  const { t } = useTranslation();
  return (
    <View className="gap-1 rounded-md bg-muted p-3">
      <Text className="text-xs uppercase tracking-wide text-muted-foreground">
        {t('state.endpointLabel')}
      </Text>
      <Text className="font-bloom-mono text-sm text-foreground" selectable>
        {endpoint}
      </Text>
    </View>
  );
}

export function ApiStateNotice({ error }: { error: unknown }) {
  const { t } = useTranslation();

  if (error instanceof ConsoleApiUnavailableError) {
    return (
      <Panel title={t('state.unavailable.title')} description={t('state.unavailable.body')}>
        <EndpointDetail endpoint={error.endpoint} />
      </Panel>
    );
  }

  if (isConsoleApiUnreachable(error)) {
    return (
      <Panel
        title={t('state.unreachable.title')}
        description={t('state.unreachable.body', { origin: API_URL })}
      />
    );
  }

  if (error instanceof ConsoleResourceMissingError) {
    return <Panel title={t('state.missing.title')} description={t('state.missing.body')} />;
  }

  if (error instanceof ConsoleForbiddenError) {
    return error.surface === 'trust-safety' ? (
      <Panel
        title={t('state.forbiddenStaff.title')}
        description={t('state.forbiddenStaff.body')}
      />
    ) : (
      <Panel title={t('state.forbidden.title')} description={t('state.forbidden.body')} />
    );
  }

  if (error instanceof ConsoleConflictError) {
    return <Panel title={t('state.conflict.title')} description={t('state.conflict.body')} />;
  }

  if (error instanceof ConsoleRateLimitedError) {
    return <Panel title={t('state.rateLimited.title')} description={t('state.rateLimited.body')} />;
  }

  if (error instanceof ConsoleServiceUnavailableError) {
    return (
      <Panel
        title={t('state.serviceUnavailable.title')}
        description={t('state.serviceUnavailable.body')}
      >
        <EndpointDetail endpoint={error.endpoint} />
      </Panel>
    );
  }

  if (error instanceof ConsoleRequestRejectedError) {
    return (
      <Panel title={t('state.rejected.title')} description={t('state.rejected.body')}>
        <EndpointDetail endpoint={error.endpoint} />
      </Panel>
    );
  }

  if (error instanceof MalformedPayloadError) {
    return (
      <Panel title={t('state.malformed.title')} description={t('state.malformed.body')}>
        {/* The PATH, which this app wrote. Never the value at it. */}
        <View className="gap-1 rounded-md bg-muted p-3">
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('state.malformed.fieldLabel')}
          </Text>
          <Text className="font-bloom-mono text-sm text-foreground" selectable>
            {error.path}
          </Text>
        </View>
      </Panel>
    );
  }

  return <Panel title={t('state.error.title')} description={t('state.error.body')} />;
}
