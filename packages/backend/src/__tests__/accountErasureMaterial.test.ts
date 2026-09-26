import { CaseEnvelopeSchema } from '@crowdsource.you/contracts';
import { describe, expect, it } from 'vitest';

import { errorClassification } from '../modules/accountErasure/accountErasure.service';
import { ERASED_ACCOUNT, erasedRowIdentity } from '../modules/accountErasure/erasedIdentity';
import {
  eraseFromEnvelope,
  eraseFromSnapshot,
  replaceFingerprint,
} from '../modules/accountErasure/materialErasure';
import { isAccountEventRefusal } from '../modules/accountErasure/oxyAccountEvents';
import { sampleEnvelope } from './support/tenants';

/**
 * The pure half of account erasure (`docs/architecture/account-erasure.md`):
 * what is removed from a stored envelope and case snapshot, and what is left
 * exactly as it was.
 */

const PERSON = '5f0c1a2b3c4d5e6f7a8b9c0d';
const OTHER = '6a1b2c3d4e5f6a7b8c9d0e1f';

function envelopeNaming(reporter: Record<string, unknown>, author: Record<string, unknown>) {
  const base = sampleEnvelope({ applicationId: 'app_test' });
  return {
    ...base,
    principalBindings: [
      { principalRef: 'author_1', ...author },
      { principalRef: 'reporter_1', ...reporter },
    ],
    allegations: [
      { code: 'harassment.targeted_abuse', reporterPrincipalRef: 'reporter_1', details: 'the reporter’s own words' },
      { code: 'harassment.targeted_abuse', reporterPrincipalRef: 'author_1', details: 'someone else’s words' },
      { code: 'harassment.targeted_abuse', reporterPrincipalRef: 'reporter_1' },
    ],
  };
}

describe('eraseFromEnvelope', () => {
  it('replaces an oxy_user reporter binding, clears only that reporter’s words, and still parses', () => {
    const stored = envelopeNaming(
      { type: 'oxy_user', externalPrincipalId: PERSON, bindingProofId: PERSON },
      { type: 'oxy_user', externalPrincipalId: OTHER, bindingProofId: OTHER },
    );

    const erased = eraseFromEnvelope(stored, PERSON);

    expect(erased.bindingsErased).toBe(1);
    expect(erased.detailsCleared).toBe(1);
    const envelope = CaseEnvelopeSchema.parse(erased.envelope);
    expect(envelope.principalBindings).toEqual([
      { principalRef: 'author_1', type: 'oxy_user', externalPrincipalId: OTHER, bindingProofId: OTHER },
      {
        principalRef: 'reporter_1',
        type: 'oxy_user',
        externalPrincipalId: ERASED_ACCOUNT,
        bindingProofId: ERASED_ACCOUNT,
      },
    ]);
    expect(envelope.allegations[0]).toEqual({ code: 'harassment.targeted_abuse', reporterPrincipalRef: 'reporter_1' });
    expect(envelope.allegations[1].details).toBe('someone else’s words');
    // The material is evidence and is not touched.
    expect(envelope.resources).toEqual(stored.resources);
    expect(JSON.stringify(erased.envelope)).not.toContain(PERSON);
  });

  it('matches the person as the AUTHOR of the material, by the binding proof alone', () => {
    const stored = envelopeNaming(
      { type: 'local_user', externalPrincipalId: 'reporter_x' },
      { type: 'oxy_user', externalPrincipalId: 'mention_local_id', bindingProofId: PERSON },
    );

    const erased = eraseFromEnvelope(stored, PERSON);

    expect(erased.bindingsErased).toBe(1);
    expect(erased.detailsCleared).toBe(1);
    expect(JSON.stringify(erased.envelope)).not.toContain(PERSON);
    expect(JSON.stringify(erased.envelope)).not.toContain('mention_local_id');
  });

  it('matches a principal id an application chose to be the Oxy id, with no proof field to replace', () => {
    const stored = envelopeNaming(
      { type: 'local_user', externalPrincipalId: PERSON },
      { type: 'local_user', externalPrincipalId: OTHER },
    );

    const erased = eraseFromEnvelope(stored, PERSON);

    expect(CaseEnvelopeSchema.parse(erased.envelope).principalBindings[1]).toEqual({
      principalRef: 'reporter_1',
      type: 'local_user',
      externalPrincipalId: ERASED_ACCOUNT,
    });
  });

  it('answers null for an envelope that does not name the person, and for one it cannot read', () => {
    const stored = envelopeNaming(
      { type: 'local_user', externalPrincipalId: OTHER },
      { type: 'local_user', externalPrincipalId: 'someone' },
    );
    expect(eraseFromEnvelope(stored, PERSON)).toEqual({ envelope: null, bindingsErased: 0, detailsCleared: 0 });
    expect(eraseFromEnvelope(null, PERSON).envelope).toBeNull();
    expect(eraseFromEnvelope({ principalBindings: 'no' }, PERSON).envelope).toBeNull();
  });

  it('leaves entries it cannot interpret exactly as they were', () => {
    const erased = eraseFromEnvelope(
      {
        principalBindings: ['odd', { externalPrincipalId: PERSON }],
        allegations: ['odd', { code: 'x', details: 'kept: no reporter ref' }],
      },
      PERSON,
    );
    expect(erased.bindingsErased).toBe(1);
    expect(erased.detailsCleared).toBe(0);
    expect(erased.envelope).toEqual({
      principalBindings: ['odd', { externalPrincipalId: ERASED_ACCOUNT }],
      allegations: ['odd', { code: 'x', details: 'kept: no reporter ref' }],
    });

    const noAllegations = eraseFromEnvelope({ principalBindings: [{ principalRef: 'p', externalPrincipalId: PERSON }] }, PERSON);
    expect(noAllegations.envelope).toEqual({
      principalBindings: [{ principalRef: 'p', externalPrincipalId: ERASED_ACCOUNT }],
      allegations: undefined,
    });
  });
});

describe('eraseFromSnapshot', () => {
  it('replaces a content principal naming the person and leaves the rest', () => {
    const snapshot = {
      resources: [{ id: 'res_post', data: { text: 'kept' } }],
      principals: [
        { principalRef: 'author_1', type: 'oxy_user', externalPrincipalId: PERSON },
        { principalRef: 'seller_1', type: 'oxy_user', externalPrincipalId: OTHER },
        'odd',
      ],
    };
    const erased = eraseFromSnapshot(snapshot, PERSON);
    expect(erased.principalsErased).toBe(1);
    expect(erased.snapshot).toEqual({
      resources: snapshot.resources,
      principals: [
        { principalRef: 'author_1', type: 'oxy_user', externalPrincipalId: ERASED_ACCOUNT },
        { principalRef: 'seller_1', type: 'oxy_user', externalPrincipalId: OTHER },
        'odd',
      ],
    });
  });

  it('answers null when nothing names the person, or the snapshot is unreadable', () => {
    expect(eraseFromSnapshot({ principals: [] }, PERSON)).toEqual({ snapshot: null, principalsErased: 0 });
    expect(eraseFromSnapshot([], PERSON).snapshot).toBeNull();
  });
});

describe('replaceFingerprint', () => {
  it('swaps the personal fingerprint and keeps the distinct-reporter count', () => {
    expect(replaceFingerprint(['a', 'mine', 'b'], 'mine', 'stand-in')).toEqual({
      fingerprints: ['a', 'stand-in', 'b'],
      replaced: 1,
    });
    expect(replaceFingerprint(['a'], 'mine', 'stand-in')).toEqual({ fingerprints: ['a'], replaced: 0 });
  });
});

describe('the sentinels and the classifications', () => {
  it('uses one prefix and a per-row form that stays unique', () => {
    expect(ERASED_ACCOUNT).toBe('erased-account');
    expect(erasedRowIdentity('rvw_1')).toBe('erased-rvw_1');
    expect(erasedRowIdentity('rvw_1')).not.toBe(erasedRowIdentity('rvw_2'));
  });

  it('records a class for a failure, never its message', () => {
    expect(errorClassification(Object.assign(new Error('secret row'), { code: '22021' }))).toBe('sqlstate_22021');
    expect(errorClassification(new TypeError('secret row'))).toBe('TypeError');
    // A Node error code is not a SQLSTATE.
    expect(errorClassification(Object.assign(new TypeError('x'), { code: 'ERR_INVALID_ARG_TYPE' }))).toBe('TypeError');
    expect(errorClassification('thrown string')).toBe('unknown');
  });

  it('treats only the SDK’s named refusal as final', () => {
    const refusal = new Error('bad signature');
    refusal.name = 'OxyAccountEventError';
    expect(isAccountEventRefusal(refusal)).toBe(true);
    expect(isAccountEventRefusal(new Error('network'))).toBe(false);
    expect(isAccountEventRefusal({ name: 'OxyAccountEventError' })).toBe(false);
  });
});
