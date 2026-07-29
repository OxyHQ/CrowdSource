/**
 * The credential, and the invariant it exists to make structural.
 *
 * Appendix F: "`applicationId` comes from the credential, never from the request
 * body." The backend enforces its half. This file asserts the client's: there is
 * no way, anywhere on the public surface, to say which application a report
 * belongs to.
 */

import { describe, expect, it } from 'vitest';

import { CrowdSource } from '../client';
import { formatServiceKey, parseServiceKey } from '../credential';
import { CrowdSourceConfigurationError } from '../errors';

const ISSUED = {
  applicationId: 'app_0123456789abcdef0123456789abcdef',
  credentialId: 'csk_fedcba9876543210fedcba9876543210',
  secret: 'a-256-bit-secret-in-base64url',
};
const SERVICE_KEY = formatServiceKey(ISSUED);

describe('the service key', () => {
  it('is the three values CrowdSource issues, joined into one opaque string', () => {
    expect(SERVICE_KEY).toBe(`${ISSUED.applicationId}:${ISSUED.credentialId}:${ISSUED.secret}`);
  });

  it('yields the application and the bearer token the API actually parses', () => {
    expect(parseServiceKey(SERVICE_KEY)).toEqual({
      applicationId: ISSUED.applicationId,
      credentialId: ISSUED.credentialId,
      bearerToken: `${ISSUED.credentialId}.${ISSUED.secret}`,
    });
  });

  it('never holds the secret as a field of its own', () => {
    const credential = parseServiceKey(SERVICE_KEY);

    expect(Object.keys(credential).sort()).toEqual([
      'applicationId',
      'bearerToken',
      'credentialId',
    ]);
  });

  it.each([
    ['an empty key', ''],
    ['only the bearer token', `${ISSUED.credentialId}.${ISSUED.secret}`],
    ['a missing secret', `${ISSUED.applicationId}:${ISSUED.credentialId}:`],
    ['a missing application', `:${ISSUED.credentialId}:${ISSUED.secret}`],
    ['an extra part', `${SERVICE_KEY}:extra`],
    ['an application id outside the identifier grammar', `app id:${ISSUED.credentialId}:s3cret`],
    ['a credential id outside the identifier grammar', `${ISSUED.applicationId}:csk id:s3cret`],
  ])('refuses %s', (_name, key) => {
    expect(() => parseServiceKey(key)).toThrow(CrowdSourceConfigurationError);
  });

  /**
   * The separator is `:` precisely because the contract's identifier grammar
   * excludes it, so the split can never be ambiguous for a value CrowdSource
   * issued. A `.` separator would be: `IdentifierSchema` allows dots inside an
   * id, and the bearer token already contains one.
   */
  it('splits unambiguously because no issued identifier can contain the separator', () => {
    expect(SERVICE_KEY.split(':')).toHaveLength(3);
    expect(parseServiceKey(SERVICE_KEY).bearerToken.split(':')).toHaveLength(1);
  });

  it('never echoes the secret in the error it throws', () => {
    let message = '';
    try {
      parseServiceKey(`not-three-parts.${ISSUED.secret}`);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).not.toContain(ISSUED.secret);
  });
});

describe('the client surface', () => {
  it('reads its applicationId off the credential', () => {
    const client = new CrowdSource({ serviceKey: SERVICE_KEY, fetch: async () => new Response() });

    expect(client.applicationId).toBe(ISSUED.applicationId);
  });

  /**
   * The invariant, as a type-level assertion rather than prose. If an
   * `applicationId` option is ever added to `CrowdSourceOptions` or to a report
   * input, this stops compiling — which is the only way a rule like this
   * survives a year of changes.
   */
  it('has no way to be told which application a report belongs to', () => {
    const optionKeys: keyof import('../client').CrowdSourceOptions extends
      | 'serviceKey'
      | 'baseUrl'
      | 'timeoutMs'
      | 'maxAttempts'
      | 'sandbox'
      | 'fetch'
      ? true
      : false = true;
    const reportKeys: 'applicationId' extends keyof import('../envelope').ReportInput
      ? false
      : true = true;
    // And the one function that does take one is not on the public surface.
    const barrelKeys: 'composeCaseEnvelope' extends keyof typeof import('../index')
      ? false
      : true = true;

    expect([optionKeys, reportKeys, barrelKeys]).toEqual([true, true, true]);
  });

  it('refuses a base URL that would put the credential on the wire in clear', () => {
    expect(
      () => new CrowdSource({ serviceKey: SERVICE_KEY, baseUrl: 'http://api.example.com' }),
    ).toThrow(CrowdSourceConfigurationError);
  });
});
