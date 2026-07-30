/**
 * The audience split, as a table.
 *
 * None of this is enforcement — the API answers 403 to a client that ignores all of it.
 * What these rules decide is whether an operator is offered a control that is going to
 * fail, and the reason they are tested here rather than exercised by rendering the app
 * is that a fabricated session is a much worse instrument than a function call.
 */

import {
  canAdminister,
  canOperateSecurity,
  canReadTrustSafety,
  hasTrustSafetyAccess,
  roleAtLeast,
} from '../roles';
import { CONSOLE_ROLES, STAFF_ROLES } from '../types';

describe('roleAtLeast', () => {
  it('orders the seats owner > admin > developer > viewer', () => {
    expect(roleAtLeast('owner', 'viewer')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('developer', 'admin')).toBe(false);
    expect(roleAtLeast('viewer', 'developer')).toBe(false);
  });

  it('derives that order from the vocabulary rather than a second table', () => {
    // Vacuity floor plus the reason the ordering is safe: `CONSOLE_ROLES` is asserted
    // against the server's in `vocabularies.test.ts`, so there is one list and one
    // order.
    expect(CONSOLE_ROLES.length).toBe(4);
    for (let index = 1; index < CONSOLE_ROLES.length; index += 1) {
      expect(roleAtLeast(CONSOLE_ROLES[index - 1], CONSOLE_ROLES[index])).toBe(true);
      expect(roleAtLeast(CONSOLE_ROLES[index], CONSOLE_ROLES[index - 1])).toBe(false);
    }
  });
});

describe('canAdminister', () => {
  it('is admin and above, matching every console write', () => {
    expect(canAdminister('owner')).toBe(true);
    expect(canAdminister('admin')).toBe(true);
    // `developer` holds no write capability yet: the surfaces it is meant for are not
    // built. Visible here rather than implied by its absence.
    expect(canAdminister('developer')).toBe(false);
    expect(canAdminister('viewer')).toBe(false);
  });
});

describe('the Trust & Safety roles', () => {
  it('gives the section to any staff role and to no ordinary account', () => {
    expect(hasTrustSafetyAccess([])).toBe(false);
    for (const role of STAFF_ROLES) {
      expect(hasTrustSafetyAccess([role])).toBe(true);
    }
  });

  it('reads the trust table with security or policy only', () => {
    expect(canReadTrustSafety(['security'])).toBe(true);
    expect(canReadTrustSafety(['policy'])).toBe(true);
    // `appeals` and `evidence` reach the section and are refused by the route, which is
    // the correct shape: the section is where staff work, and the API decides which
    // part of it answers.
    expect(canReadTrustSafety(['appeals'])).toBe(false);
    expect(canReadTrustSafety(['evidence'])).toBe(false);
    expect(canReadTrustSafety([])).toBe(false);
  });

  it('moves a standing with security only', () => {
    // Standing decides whether an application may ingest at all and whether its
    // decisions may ever move an Oxy Trust figure. A policy operator adjusting a
    // taxonomy has no business granting it.
    expect(canOperateSecurity(['security'])).toBe(true);
    expect(canOperateSecurity(['policy'])).toBe(false);
    expect(canOperateSecurity(['policy', 'appeals', 'evidence'])).toBe(false);
    expect(canOperateSecurity(['policy', 'security'])).toBe(true);
    expect(canOperateSecurity([])).toBe(false);
  });
});
