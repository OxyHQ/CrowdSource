/**
 * The two things this package borrows from `@oxy.so/core`, loaded only when a
 * first-party Oxy service asks for them.
 *
 * `@oxy.so/core` is an OPTIONAL peer dependency. A third party integrating with
 * CrowdSource holds a service key and must never be made to install Oxy's SDK to
 * get one, so nothing here is imported at module load: the root entry point has
 * to stay loadable in a tree where `@oxy.so/core` is simply absent, and a static
 * import would make `import '@crowdsource.you/core'` throw there — for everyone,
 * over a path almost nobody takes.
 *
 * ## Why `createRequire` and not `import()`
 *
 * `crowdSourceForOxyService()` answers synchronously, because it is called where
 * a module-level `const` is assigned; an application that had to await its
 * client would have to await every module that holds one. A dynamic `import()`
 * is a promise in the ESM half of this build, so the load has to be a require.
 *
 * Resolution is anchored on the APPLICATION's directory rather than on this
 * file. One anchor that works in both halves of a dual build is the reason:
 * `__filename` does not exist in the ESM emit and `import.meta.url` does not
 * compile in the CommonJS one, whereas `process.cwd()` is the same in both. An
 * optional peer belongs to the application anyway — it is the application that
 * declared and installed it.
 *
 * A specifier that does not resolve is not an error here. It is the honest
 * answer to "is this an Oxy service": a process without Oxy's SDK cannot mint an
 * Oxy service token, which is the same answer a local checkout gets.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

/** The api key half of an Oxy service credential. */
export const OXY_SERVICE_API_KEY_ENV_VAR = 'OXY_SERVICE_API_KEY';

/** Its secret half. Both or neither: one alone authenticates nothing. */
export const OXY_SERVICE_API_SECRET_ENV_VAR = 'OXY_SERVICE_API_SECRET';

/**
 * `@oxy.so/core/server`, narrowed to the one function this package calls.
 *
 * Declared rather than imported as a type. `import type` from an optional peer
 * compiles only where that peer is installed, so typing this from the package
 * would make `@crowdsource.you/core` fail to build in a tree that deliberately
 * does not have it — including this one.
 *
 * The member is optional because a peer RANGE is advice, not enforcement:
 * `^1.6.0` is what this package asks for, and a tree that resolved an older
 * copy — one with no attestation path at all — has to read as "cannot attest"
 * rather than as a `TypeError` thrown from inside a moderation client.
 */
interface OxyServerModule {
  readonly canAttestWorkloadIdentity?: () => boolean;
}

/** `@oxy.so/core`, narrowed to the one object this package calls. */
interface OxyCoreModule {
  readonly oxyClient?: {
    getServiceToken(apiKey?: string, apiSecret?: string): Promise<string>;
  };
}

const requireFromApplication = createRequire(join(process.cwd(), 'package.json'));

function loadOxyModule<T>(specifier: string): T | null {
  try {
    return requireFromApplication(specifier) as T;
  } catch {
    return null;
  }
}

/**
 * Whether this process can prove what it is to Oxy without a secret.
 *
 * In ECS the task role attests — a signed `GetCallerIdentity` that Oxy replays
 * to AWS, with nothing stored anywhere (oxy ADR 0026). A local checkout has no
 * attestation to offer and must fall back to a credential.
 */
export function canAttestWorkloadIdentity(): boolean {
  const server = loadOxyModule<OxyServerModule>('@oxy.so/core/server');
  return server?.canAttestWorkloadIdentity?.() === true;
}

/**
 * The service credential pair this process was given, or `null`.
 *
 * Blank is absent. A task definition that declares the variable and leaves it
 * empty is the shape this actually arrives in, and a pair of empty strings
 * treated as present builds a client whose every request fails at the token
 * call — the failure this whole module exists to answer before it happens.
 */
export function oxyServiceCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env[OXY_SERVICE_API_KEY_ENV_VAR]?.trim();
  const apiSecret = process.env[OXY_SERVICE_API_SECRET_ENV_VAR]?.trim();
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

/**
 * A current Oxy service token, minted the way `@oxy.so/core` mints one.
 *
 * The credential pair is passed rather than installed with
 * `configureServiceAuth()`, so this never mutates the SDK's shared client out
 * from under an application that configured it for itself. With no pair,
 * `getServiceToken()` attests instead — the same order the SDK chose
 * deliberately, so that a deployment still holding a credential keeps using it
 * and dropping the two variables is the whole migration.
 *
 * The token is cached and re-minted on expiry INSIDE the SDK, which is why this
 * can be asked once per request attempt.
 */
export function oxyServiceToken(): Promise<string> {
  const core = loadOxyModule<OxyCoreModule>('@oxy.so/core');
  const oxyClient = core?.oxyClient;
  if (oxyClient === undefined) {
    return Promise.reject(
      new Error(
        "@oxy.so/core is not installed, so this process cannot mint an Oxy service token. Install it, or pass an 'oxyToken' provider of your own.",
      ),
    );
  }

  const credentials = oxyServiceCredentials();
  return credentials === null
    ? oxyClient.getServiceToken()
    : oxyClient.getServiceToken(credentials.apiKey, credentials.apiSecret);
}
