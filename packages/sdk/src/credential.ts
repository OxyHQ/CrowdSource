/**
 * The service key, and the only place `applicationId` may come from.
 *
 * Appendix F: "`applicationId` comes from the credential, never from the request
 * body." The backend already honours that — it derives the tenant from the
 * presented token and 403s an envelope naming a different application. But the
 * Case Envelope contract still REQUIRES `applicationId` on the wire, so a client
 * has to put one there, and the question this module answers is where it gets it
 * from without ever asking the integrator.
 *
 * The answer is that it comes out of the credential, literally. CrowdSource
 * issues three values together (`provisioning.service.ts`
 * `IssuedCredential`): the application the credential belongs to, the credential
 * id, and the secret. Joined into ONE opaque string, they are a single
 * environment variable an integrator pastes and never reads — and the
 * `applicationId` in an envelope is then a value the client READ OFF THE
 * CREDENTIAL, not a parameter anyone can pass. There is no `applicationId`
 * option on the client, none on any method, and none an envelope input can
 * carry; supplying one is not "discouraged", it is unexpressible.
 *
 * `:` is the separator because the contract's identifier grammar excludes it and
 * credential secrets are base64url, so the split is unambiguous for every value
 * CrowdSource can issue. A `.` separator would not be: `IdentifierSchema` allows
 * dots inside an id.
 *
 * NOTE FOR THE CONSOLE: `issueApplicationCredential` returns the three values
 * separately and the bearer token as `<credentialId>.<secret>`. Whatever surface
 * shows an integrator their key must show `formatServiceKey(issued)` — the
 * composite below — or the integrator has two values to configure instead of
 * one, and the client has no way to know its own application.
 */

import { IdentifierSchema } from '@oxyhq/crowdsource-contracts';

import { CrowdSourceConfigurationError } from './errors.js';

const SERVICE_KEY_SEPARATOR = ':';

/** The credential CrowdSource issues, parsed. */
export interface ServiceCredential {
  /** The application this credential belongs to. The tenant, and its only source. */
  readonly applicationId: string;
  readonly credentialId: string;
  /**
   * The bearer token the API authenticates — `<credentialId>.<secret>`, exactly
   * what `credential.service.ts` parses. The secret is never held on its own,
   * so nothing in this client can log or serialise it by touching a field.
   */
  readonly bearerToken: string;
}

/** The three values `issueApplicationCredential` returns, as one opaque key. */
export function formatServiceKey(issued: {
  applicationId: string;
  credentialId: string;
  secret: string;
}): string {
  return [issued.applicationId, issued.credentialId, issued.secret].join(SERVICE_KEY_SEPARATOR);
}

/**
 * Parses a service key.
 *
 * Every rejection names which part is wrong and none of them echoes the secret:
 * a configuration error is read from a log, and a log line is the second most
 * common way a credential leaks after a screenshot.
 */
export function parseServiceKey(serviceKey: string): ServiceCredential {
  const trimmed = serviceKey.trim();
  if (!trimmed) {
    throw new CrowdSourceConfigurationError('The CrowdSource service key is empty.');
  }

  const parts = trimmed.split(SERVICE_KEY_SEPARATOR);
  if (parts.length !== 3) {
    throw new CrowdSourceConfigurationError(
      `A CrowdSource service key is three colon-separated parts (applicationId:credentialId:secret); this one has ${parts.length}.`,
    );
  }

  const [applicationId, credentialId, secret] = parts;

  if (!IdentifierSchema.safeParse(applicationId).success) {
    throw new CrowdSourceConfigurationError(
      'The first part of a CrowdSource service key must be the applicationId it was issued for.',
    );
  }
  if (!IdentifierSchema.safeParse(credentialId).success) {
    throw new CrowdSourceConfigurationError(
      'The second part of a CrowdSource service key must be the credentialId it was issued for.',
    );
  }
  if (!secret) {
    throw new CrowdSourceConfigurationError(
      'The third part of a CrowdSource service key must be the credential secret.',
    );
  }

  return { applicationId, credentialId, bearerToken: `${credentialId}.${secret}` };
}
