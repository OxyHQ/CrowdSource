import { CrowdSource, crowdSourceForOxyService } from '../index.js';
import type { OxyServiceClientLogger } from '../index.js';
import type { CrowdSourceAuth, CrowdSourceConnectionConfig, ModerationLogger } from './types.js';

/**
 * The CrowdSource client, built once and only when configured.
 *
 * There is deliberately almost nothing here. The SDK already owns the base URL,
 * the timeouts, the bounded per-attempt retries, the idempotency key and the
 * error classification, and a wrapper that re-implemented any of them would be a
 * second answer to a question that has one. What this adds is exactly two
 * things: the client is absent until the integration is switched on, and it is
 * built once rather than per delivery.
 *
 * `applicationId` appears nowhere — the client reads it off the service key, or
 * asks CrowdSource which tenant its Oxy token names, and there is no option,
 * field or parameter through which one could be passed.
 */
export interface CrowdSourceClientProvider {
  /**
   * The client, or `undefined` when the integration is not configured.
   *
   * `undefined` rather than a throw: a disabled integration is the normal state
   * of a local checkout and of every deployment before rollout, and a report
   * filed there must still be stored. The delivery worker is what notices there
   * is nowhere to send it.
   *
   * A MISCONFIGURED client — a malformed service key, or an `'oxy-service'`
   * deployment that cannot obtain an Oxy token — is a different thing and is
   * logged once at error level. Once, because the alternative is one line per
   * delivery attempt per report, which buries the cause it is meant to reveal.
   */
  get(): CrowdSource | undefined;
}

/**
 * Why no client was built, and under which of the two messages to say so.
 *
 * Returned rather than logged where it is discovered, so that recording the
 * reason and reporting it happen in ONE place. They have to stay together: the
 * recorded reason is what suppresses every later line, and a path that logged
 * without recording would say the same thing once per delivery attempt — the
 * behaviour the "once" above exists to prevent.
 */
interface ClientRefusal {
  readonly message: string;
  readonly reason: string;
}

type ClientAttempt = CrowdSource | ClientRefusal;

interface ProviderInput {
  config: CrowdSourceConnectionConfig;
  logger: ModerationLogger;
}

export function createClientProvider(input: ProviderInput): CrowdSourceClientProvider {
  let client: CrowdSource | null = null;
  let configurationError: string | null = null;

  return {
    get(): CrowdSource | undefined {
      if (!input.config.enabled) return undefined;
      if (client) return client;
      if (configurationError !== null) return undefined;

      /**
       * Two identities, and the config says which — it is never guessed from
       * what happens to be set. See {@link CrowdSourceAuth} for why inferring it
       * from an absent key is the one thing this must not do.
       */
      const attempt =
        input.config.auth === 'oxy-service' ? fromOxyIdentity(input) : fromServiceKey(input);

      if (attempt instanceof CrowdSource) {
        client = attempt;
        return client;
      }

      configurationError = attempt.reason;
      input.logger.error(attempt.message, { auth: authMode(input.config), reason: attempt.reason });
      return undefined;
    },
  };
}

/** The mode in force, with the default made explicit for the log line. */
function authMode(config: CrowdSourceConnectionConfig): CrowdSourceAuth {
  return config.auth ?? 'service-key';
}

/**
 * The third-party path, and the one every deployment written before `auth`
 * existed takes.
 */
function fromServiceKey(input: ProviderInput): ClientAttempt {
  const serviceKey = input.config.serviceKey;
  if (!serviceKey) {
    return {
      message: '[CrowdSource] enabled but not configured',
      /**
       * Both doors named, because there are now two and an operator who
       * configured neither cannot tell that from a message naming one. A
       * deployment reaching this line has an outbox filling up and nowhere to
       * send it, which is the state that is otherwise indistinguishable from
       * "no reports yet".
       */
      reason: "no CrowdSource service key is configured, and crowdSource.auth is not 'oxy-service'",
    };
  }

  try {
    const built = new CrowdSource({
      serviceKey,
      ...(input.config.baseUrl === undefined ? {} : { baseUrl: input.config.baseUrl }),
    });
    input.logger.info('[CrowdSource] client ready', {
      auth: 'service-key',
      applicationId: built.applicationId,
    });
    return built;
  } catch (error: unknown) {
    // The SDK's configuration errors name which part of the key is wrong and
    // never echo the secret, so the message is safe to log.
    return {
      message: '[CrowdSource] service key rejected',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The first-party path: the same decision `crowdSourceForOxyService()` already
 * makes, asked rather than repeated.
 *
 * Nothing here decides whether this process can be an Oxy service, which token
 * provider to use or when to give up — all three live in the factory, and three
 * applications' worth of duplicated copies is exactly why they were moved there.
 * What this adds is the part the factory cannot know: that an integration which
 * asked for this identity and did not get one is MISCONFIGURED. The factory
 * answers `undefined` for a laptop, where that is correct and unremarkable; an
 * outbox deployment that set `auth: 'oxy-service'` and switched delivery on
 * meant it, so the same answer is an error here.
 *
 * The factory's client is one per PROCESS. Two integrations in one process on
 * this path therefore share it, which is right — the token names one Oxy
 * application, so a second client would ask CrowdSource which tenant that is all
 * over again and be told the same thing. It is also why `baseUrl` here is the
 * first caller's: a test that needs a different one calls
 * `resetCrowdSourceForOxyService()`, which is what that hook is for.
 */
function fromOxyIdentity(input: ProviderInput): ClientAttempt {
  /**
   * A key that is configured and never read is not a failure, but it is still a
   * secret this deployment holds, stores and has to protect. Said at the boot
   * that built the client, because deleting it is the last step of a migration
   * off shared secrets and nothing else will ever mention it again.
   */
  if (input.config.serviceKey) {
    input.logger.warn('[CrowdSource] the configured service key is not used', {
      auth: 'oxy-service',
    });
  }

  const built = crowdSourceForOxyService({
    logger: taggedLogger(input.logger),
    ...(input.config.baseUrl === undefined ? {} : { baseUrl: input.config.baseUrl }),
  });

  if (built === undefined) {
    return {
      message: '[CrowdSource] enabled but not configured',
      reason:
        "crowdSource.auth is 'oxy-service' but this process cannot obtain an Oxy service token",
    };
  }
  return built;
}

/**
 * The factory's own lines, each carrying the identity this deployment chose.
 *
 * The factory is reached by an application that configured nothing, so it cannot
 * name a mode it was never told about — and which credential is in use is the
 * first thing an operator needs when nothing is being delivered. Added to the
 * lines that already exist rather than announced on one of its own: a second
 * "client ready" per boot is how a startup log stops being read.
 *
 * `...context` after `auth` so the factory's own fields win a name collision.
 * This wrapper is decoration on somebody else's message; it must not be able to
 * overwrite what that message came to say.
 */
function taggedLogger(logger: ModerationLogger): OxyServiceClientLogger {
  return {
    info: (message, context) => {
      logger.info(message, { auth: 'oxy-service', ...context });
    },
    error: (message, context) => {
      logger.error(message, { auth: 'oxy-service', ...context });
    },
  };
}
