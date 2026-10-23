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

export type OxyRequester = { accountId: string } & (
  | { token: string; taskId?: never; requesterContext?: never }
  | { taskId: string; token?: never; requesterContext?: never }
  | { requesterContext: string; token?: never; taskId?: never }
);

/** The optional shared SDK owns authentication, audience and proof transport. */
export interface OxyServiceHost {
  createServiceClient(options: { baseURL: string; audience: string; requester?: OxyRequester }): {
    fetch: typeof globalThis.fetch;
    dispose(): void;
  };
}
interface OxyServerModule {
  readonly canAttestWorkloadIdentity?: () => boolean;
  readonly OxyServer?: new (config: { baseURL: string }) => OxyServiceHost;
}

/** Oxy's API origin: `OXY_API_URL`, else production — the SDK's own default. */
const OXY_API_URL_ENV_VAR = 'OXY_API_URL';
const OXY_API_URL_DEFAULT = 'https://api.oxy.so';

/**
 * Where to resolve the optional peer FROM, in the order worth trying.
 *
 * The application's directory first: an optional peer belongs to the
 * application, which is what declared and installed it. Then this file, when the
 * running half of the dual build has a `__filename` — the CommonJS one does, the
 * ESM one does not, and `typeof` is what makes asking safe in both. That second
 * anchor is not decoration: a process whose working directory is not its package
 * root resolves nothing from the first, and the answer would be a silent
 * "cannot attest" — a moderation client that is `undefined` for a reason nobody
 * can see, which is precisely the failure this module is supposed to prevent.
 */
function resolutionAnchors(): string[] {
  const anchors = [join(process.cwd(), 'package.json')];
  if (typeof __filename === 'string') anchors.push(__filename);
  return anchors;
}

/** Why the last load failed, for a caller that has somewhere to report it. */
let lastResolutionError: string | null = null;

/**
 * The loader itself, for the one test that has to prove a successful resolution
 * clears the recorded reason. Exported rather than re-implemented in the suite:
 * a test that reimplemented it would pass while this one rotted.
 */
export function loadOptionalModuleForTest(specifier: string): unknown {
  return loadOxyModule<unknown>(specifier);
}

/** The reason `@oxy.so/core` could not be loaded, or `null` if it was. */
export function oxySdkResolutionError(): string | null {
  return lastResolutionError;
}

function loadOxyModule<T>(specifier: string): T | null {
  let failure: unknown;
  for (const anchor of resolutionAnchors()) {
    try {
      const loaded = createRequire(anchor)(specifier) as T;
      lastResolutionError = null;
      return loaded;
    } catch (error: unknown) {
      failure = error;
    }
  }
  lastResolutionError = `${specifier}: ${failure instanceof Error ? failure.message : String(failure)}`;
  return null;
}

/**
 * Whether this process can prove what it is to Oxy without a secret.
 *
 * In ECS the task role attests — a signed `GetCallerIdentity` that Oxy replays
 * to AWS, with nothing stored anywhere (oxy ADR 0026). A local checkout must supply a configured shared workload client.
 */
export function canAttestWorkloadIdentity(): boolean {
  const server = loadOxyModule<OxyServerModule>('@oxy.so/core/server');
  return server?.canAttestWorkloadIdentity?.() === true;
}

let server: OxyServiceHost | undefined;

export function oxyServiceHost(): OxyServiceHost {
  if (server) return server;
  const OxyServer = loadOxyModule<OxyServerModule>('@oxy.so/core/server')?.OxyServer;
  if (!OxyServer) throw new Error('@oxy.so/core >=7 <8 is required for own service transport.');
  server = new OxyServer({
    baseURL: process.env[OXY_API_URL_ENV_VAR]?.trim() || OXY_API_URL_DEFAULT,
  });
  return server;
}
