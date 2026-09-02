/**
 * The console's copies of the server's closed vocabularies are still the server's.
 *
 * `types.ts` declares each vocabulary as a runtime `const` array because
 * `projections.ts` REJECTS a value it does not recognise — which is the right failure
 * for an outcome (an unknown one cannot be rendered truthfully) and a brittle one if the
 * lists ever drift. This file is what stops them drifting: it reads the SERVER's
 * declarations and asserts each list is still equal.
 *
 * A new case status shipping backend-side therefore shows up here as a failing test in
 * CI, long before it is a rejected payload in an operator's browser.
 *
 * The backend is read as TEXT rather than imported. The precedent is the repository's
 * own `sdk/src/__tests__/defaults.test.ts`, and the reason is the same: importing the
 * backend package into a jest-expo runtime just to read a string array would be a much
 * larger coupling than a regex over its storage-independent vocabulary file. Every extraction below asserts it found something first, so a
 * moved file or a renamed constant fails loudly instead of comparing against nothing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  APPLICATION_SCOPES,
  APPLICATION_STANDINGS,
  APPLICATION_STATUSES,
  CASE_STATUSES,
  CONSOLE_ROLES,
  CREDENTIAL_STATUSES,
  DECISION_OUTCOMES,
  MEMBER_STATUSES,
  ORGANIZATION_SLUG_PATTERN,
  ORGANIZATION_STATUSES,
  STANDING_REASONS,
} from '../types';

const BACKEND = join(__dirname, '..', '..', '..', '..', 'backend', 'src');
const CONTRACTS = join(__dirname, '..', '..', '..', '..', 'contracts', 'src');
const CLOSED_VALUES = join(BACKEND, 'domain', 'closedValues.ts');

/**
 * The string literals of an `export const NAME = [...] as const;` declaration.
 *
 * Comments inside the array are stripped first — the backend documents several of these
 * vocabularies member by member, and a `//` line mentioning another code would otherwise
 * be scanned as one.
 */
function readStringArray(file: string, name: string): string[] {
  const source = readFileSync(file, 'utf8');
  const declaration = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  if (declaration === null) {
    throw new Error(`No 'export const ${name} = [...] as const' in ${file}`);
  }
  const body = declaration[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('the vocabularies this console validates against', () => {
  it('matches the backend case statuses', () => {
    const server = readStringArray(CLOSED_VALUES, 'CASE_STATUSES');
    expect(server.length).toBeGreaterThan(5);
    expect([...CASE_STATUSES]).toEqual(server);
  });

  it('matches the contracts decision outcomes', () => {
    const contract = readStringArray(join(CONTRACTS, 'decisions.ts'), 'DECISION_OUTCOMES');
    expect(contract).toContain('inconclusive');
    expect(contract).toContain('no_violation');
    expect([...DECISION_OUTCOMES]).toEqual(contract);
  });

  it('matches the grantable application scopes', () => {
    const server = readStringArray(
      join(BACKEND, 'modules', 'tenancy', 'scopes.ts'),
      'APPLICATION_SCOPES',
    );
    expect(server.length).toBe(8);
    expect([...APPLICATION_SCOPES]).toEqual(server);
  });

  it('grants no privileged scope', () => {
    // The list above is what the console offers. A privileged scope appearing in it
    // would be a form asking for something no role can self-grant, and the request
    // schema would reject the whole credential.
    const privileged = readStringArray(
      join(BACKEND, 'modules', 'tenancy', 'scopes.ts'),
      'PRIVILEGED_SCOPES',
    );
    expect(privileged.length).toBeGreaterThan(0);
    for (const scope of privileged) {
      expect(APPLICATION_SCOPES).not.toContain(scope);
    }
  });

  it('matches the console roles and their order', () => {
    // The ORDER is load-bearing: `roleAtLeast` derives the hierarchy from the index in
    // this array rather than from a second table of ranks.
    const server = readStringArray(CLOSED_VALUES, 'CONSOLE_ROLES');
    expect(server).toEqual(['owner', 'admin', 'developer', 'viewer']);
    expect([...CONSOLE_ROLES]).toEqual(server);
  });

  it('matches the member statuses', () => {
    const server = readStringArray(CLOSED_VALUES, 'MEMBER_STATUSES');
    expect([...MEMBER_STATUSES]).toEqual(server);
  });

  it('matches the organization and application statuses', () => {
    expect([...ORGANIZATION_STATUSES]).toEqual(
      readStringArray(CLOSED_VALUES, 'ORGANIZATION_STATUSES'),
    );
    expect([...APPLICATION_STATUSES]).toEqual(
      readStringArray(CLOSED_VALUES, 'APPLICATION_STATUSES'),
    );
    expect([...CREDENTIAL_STATUSES]).toEqual(
      readStringArray(CLOSED_VALUES, 'CREDENTIAL_STATUSES'),
    );
  });

  it('matches the application standings and standing reasons', () => {
    const standings = readStringArray(CLOSED_VALUES, 'APPLICATION_STANDINGS');
    const reasons = readStringArray(CLOSED_VALUES, 'STANDING_REASONS');
    expect(standings.length).toBe(3);
    expect(reasons.length).toBeGreaterThan(3);
    expect([...APPLICATION_STANDINGS]).toEqual(standings);
    expect([...STANDING_REASONS]).toEqual(reasons);
  });

  it('validates an organization slug exactly as the server does', () => {
    // Client-side validation exists so a typo is a message under the field rather than a
    // 400. A pattern stricter than the server's rejects a name the server would have
    // accepted; a looser one sends a request that fails.
    const source = readFileSync(
      join(BACKEND, 'modules', 'tenancy', 'provisioning.service.ts'),
      'utf8',
    );
    const pattern = /\/\^\[a-z0-9\]\[a-z0-9-\]\{1,62\}\$\//.exec(source);
    expect(pattern).not.toBeNull();
    expect(ORGANIZATION_SLUG_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{1,62}$');
  });
});
