import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  APPEAL_REASONS,
  CONTEXT_SUFFICIENCIES,
  DECISION_OUTCOMES,
  FINDING_CONTEXTS,
  FINDING_SCOPES,
  OXY_CONDUCT_POLICY_VERSION,
  PolicyRuleSchema,
  PolicySetVersionSchema,
  RECOMMENDED_ACTIONS,
  RECUSAL_REASONS,
  REPORT_STATUSES,
  REVIEW_OUTCOMES,
  SEVERITIES,
  TAXONOMY_FAMILIES,
  UNIVERSAL_TAXONOMY_CODES,
  UNIVERSAL_TAXONOMY_VERSION,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_RETRY_SCHEDULE_SECONDS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  ASSIGNMENT_TOKEN_HEADER,
  DecisionFindingSchema,
} from '@oxyhq/crowdsource-contracts';
import { describe, expect, it } from 'vitest';

import { config } from '../config';
import { API_ERROR_STATUS } from '../http/apiError';
import { APPEALABLE_OUTCOMES } from '../modules/appeals/appeal.service';
import { AUDIT_ACTIONS, AUDIT_REASONS } from '../modules/audit/audit.collection';
import {
  MINIMUM_AGREEING_VOTES,
  ROUND_AGREEING_VOTES,
} from '../modules/consensus/consensus';
import { CONSOLE_ROLES, STAFF_ROLES } from '../modules/console/console.collections';
import { STAFF_AUDIT_ACTIONS } from '../modules/console/staffAudit.collection';
import { OUTBOX_STATUSES } from '../db/postgres/schema/infrastructure';
import { WEBHOOK_DEAD_LETTER_REASONS } from '../db/postgres/schema/webhooks';
import { OUTBOX_EVENT_TYPES } from '../modules/outbox/outbox.collection';
import {
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
} from '../modules/outbox/outbox.dispatcher';
import {
  BASELINE_POLICY_SET,
  BASELINE_POLICY_SET_ID,
  BASELINE_POLICY_VERSION,
} from '../modules/policy/policyBaseline';
import { ELIGIBILITY_REJECTIONS } from '../modules/reviewer/eligibility';
import { DRAW_KINDS, DRAW_STATUSES } from '../db/postgres/schema/sortition';
import { SORTITION_RULES_VERSION } from '../modules/sortition/draw.collection';
import { EXCLUSION_REASONS } from '../modules/sortition/exclusions';
import { SLOT_TYPES, panelSpecFor } from '../modules/sortition/panelSpec';
import { PANEL_REFUSAL_REASONS } from '../modules/sortition/weightedSampling';
import { APPLICATION_SCOPES, PRIVILEGED_SCOPES } from '../modules/tenancy/scopes';
import { REVIEW_POOLS, SENSITIVITY_CLASSES } from '../modules/triage/triage';
import { APPLICATION_STANDINGS } from '../modules/trust/applicationTrust.collection';
import { QUOTAS_BY_STANDING } from '../modules/trust/quota';
import { WEBHOOK_DELIVERY_LEASE_MS } from '../modules/webhooks/delivery.service';
import { webhookSourcedEventTypes } from '../modules/webhooks/fanout';
import {
  WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS,
  WEBHOOK_MAX_ATTEMPTS,
} from '../modules/webhooks/retrySchedule';
import {
  WEBHOOK_FAILURE_KINDS,
} from '../modules/webhooks/webhook.collections';

/**
 * The published documentation, gated.
 *
 * `docs/` is the one place in this repository where a wrong statement persists
 * indefinitely: every package's `files` list excludes it, so no consumer ever
 * trips over a stale claim there to force a correction. `docs/README.md` states
 * the rule this file implements — anything load-bearing enough to be relied on
 * gets a test that fails when it drifts — and `docs/architecture/appeals.md`
 * plus `appealsAdr.test.ts` are the pattern it follows.
 *
 * Two kinds of claim are checked, and the second is the one this file exists
 * for.
 *
 *  1. **Fenced `docs-claims` blocks.** `key: value` lines compared against
 *     exported constants. Cheap, and covers the enums and numbers an integrator
 *     or an operator reads off a page and acts on.
 *  2. **The ROUTE TABLES, from the visible markdown.** Every documented row must
 *     be served, every served route must be documented, and — the property the
 *     API documentation is organised around — each must be behind the caller
 *     class its document claims. A service credential must never satisfy a
 *     session route and vice versa, and this is where a new route that blurred
 *     them would be caught by the documentation rather than by a reader.
 *
 * The visible table is what is parsed rather than a duplicate of it in a fenced
 * block, so there is nothing to keep in step with the thing a human reads.
 *
 * Both defences the ecosystem's own lesson asks for are here: a vacuity floor
 * (every parser asserts it found a plausible number of things, so an emptied
 * block or a broken traversal fails rather than passes) and mutation tests
 * (each parser is shown to reject the drift it claims to catch).
 */

const docsRoot = path.resolve(__dirname, '..', '..', '..', '..', 'docs');
const routesRoot = path.resolve(__dirname, '..', 'modules');

function doc(relativePath: string): string {
  return readFileSync(path.join(docsRoot, relativePath), 'utf8');
}

// --- the fenced claims blocks -----------------------------------------------

/** The `key: value` lines of a fenced `docs-claims` block. */
export function parseClaims(document: string): ReadonlyMap<string, readonly string[]> {
  const fenced = /```docs-claims\n([\s\S]*?)```/.exec(document);
  if (!fenced) throw new Error('this document has no fenced `docs-claims` block');

  const claims = new Map<string, readonly string[]>();
  for (const line of fenced[1].split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(':');
    if (separator < 0) throw new Error(`claim line is not 'key: value': ${trimmed}`);
    claims.set(
      trimmed.slice(0, separator).trim(),
      trimmed
        .slice(separator + 1)
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  }
  if (claims.size === 0) throw new Error('the `docs-claims` block is empty');
  return claims;
}

class ClaimReader {
  private readonly claims: ReadonlyMap<string, readonly string[]>;
  private readonly asked = new Set<string>();

  constructor(readonly name: string, document: string) {
    this.claims = parseClaims(document);
  }

  list(key: string): readonly string[] {
    this.asked.add(key);
    const value = this.claims.get(key);
    if (!value) throw new Error(`${this.name} does not state '${key}'`);
    return value;
  }

  one(key: string): string {
    const value = this.list(key);
    expect(value, `${this.name}: '${key}' should be one value`).toHaveLength(1);
    return value[0];
  }

  number(key: string): number {
    const value = Number(this.one(key));
    expect(Number.isFinite(value), `${this.name}: '${key}' should be a number`).toBe(true);
    return value;
  }

  /** The vacuity floor: no claim may sit in the block unread by this file. */
  assertEveryClaimWasChecked(): void {
    expect([...this.claims.keys()].sort(), `${this.name}: unchecked claims`).toEqual(
      [...this.asked].sort(),
    );
  }
}

/** Sorted, so a claim and a constant are compared as sets rather than as orderings. */
function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

// --- the route tables -------------------------------------------------------

const CALLER_CLASSES = ['service-credential', 'reviewer-session', 'console-session', 'staff-session'] as const;
type CallerClass = (typeof CALLER_CLASSES)[number];

interface ServedRoute {
  /** `GET /reviewer/assignments/*` — path parameters normalised away. */
  readonly signature: string;
  readonly callerClass: CallerClass;
  /** The scope named at the mount point, for a service-credential route. */
  readonly scope: string | null;
  readonly file: string;
}

/**
 * A path with every parameter segment replaced by `*`.
 *
 * The documentation writes `{assignmentId}` and Express writes `:assignmentId`,
 * and neither spelling is the claim being checked — what is checked is that the
 * same routes exist with the same shape. Normalising keeps a rename of a path
 * parameter from failing a documentation gate for no reason, while an added,
 * removed or moved segment still fails.
 */
function normalisePath(routePath: string): string {
  return routePath
    .split('/')
    .map((segment) => (segment.startsWith(':') || segment.startsWith('{') ? '*' : segment))
    .join('/');
}

function routeFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') found.push(...routeFiles(full));
    } else if (entry.name.endsWith('.routes.ts')) {
      found.push(full);
    }
  }
  return found.sort();
}

const GUARD_CLASSES: ReadonlyMap<string, CallerClass> = new Map([
  ['requireServiceCredential', 'service-credential'],
  ['requireReviewerSession', 'reviewer-session'],
  ['requireConsoleSession', 'console-session'],
  ['requireStaffRole', 'staff-session'],
]);

/**
 * Every route the backend mounts, with the guard it is mounted behind.
 *
 * A source scan rather than a walk of the built Express router, because the
 * GUARD is the thing being checked and an assembled router only exposes
 * anonymous handler functions. The regex requires a guard immediately after the
 * path, so a route mounted with no guard at all does not silently parse as one
 * caller class or another — it fails the count floor below.
 */
export function servedRoutes(): readonly ServedRoute[] {
  const pattern =
    /\w+Router\.(get|post|put|patch|delete)\(\s*\n?\s*'([^']+)'\s*,\s*\n?\s*(?:\.\.\.)?(require\w+)\(([^)]*)\)/g;

  const routes: ServedRoute[] = [];
  for (const file of routeFiles(routesRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const [, method, routePath, guard, guardArguments] = match;
      const callerClass = GUARD_CLASSES.get(guard);
      if (!callerClass) throw new Error(`${file}: unknown route guard '${guard}'`);

      routes.push({
        signature: `${method.toUpperCase()} ${normalisePath(routePath)}`,
        callerClass,
        scope:
          callerClass === 'service-credential'
            ? (/'([^']+)'/.exec(guardArguments)?.[1] ?? null)
            : null,
        file: path.relative(routesRoot, file),
      });
    }
  }
  return routes;
}

interface DocumentedRoute {
  readonly signature: string;
  /** The third column, where the table has one: a scope, a seat or a role. */
  readonly qualifier: string | null;
}

/**
 * The route rows of a document's visible markdown tables.
 *
 * Any table row whose first cell is an HTTP method and whose second is a `/v1/`
 * path, wherever it appears. That deliberately does not care which table it came
 * from — a route moved between two tables in one document is not a drift worth
 * failing on, and a route moved between two DOCUMENTS is caught by the
 * caller-class assertion instead.
 */
export function documentedRoutes(document: string): readonly DocumentedRoute[] {
  const rows: DocumentedRoute[] = [];
  for (const line of document.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;

    const method = cells[0].toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;

    const routePath = cells[1].replace(/`/g, '').trim();
    if (!routePath.startsWith('/v1/')) continue;

    rows.push({
      signature: `${method} ${normalisePath(routePath.slice('/v1'.length))}`,
      qualifier: cells[2] === undefined ? null : cells[2].replace(/`/g, '').trim(),
    });
  }
  return rows;
}

// --- the documents ----------------------------------------------------------

const integration = doc('integration.md');
const applicationApi = doc('api/application.md');
const reviewerApi = doc('api/reviewer.md');
const consoleApi = doc('api/console.md');
const webhooksApi = doc('api/webhooks.md');
const policies = doc('policies/README.md');
const deadLetters = doc('runbooks/webhook-dead-letters.md');
const outbox = doc('runbooks/outbox-backlog.md');
const empanel = doc('runbooks/case-cannot-empanel.md');
const auditTrails = doc('runbooks/audit-trails.md');

describe('the route tables describe the routes that are served', () => {
  const served = servedRoutes();

  it('found every route, behind a recognised guard', () => {
    // The vacuity floor. A traversal that stopped early, or a regex that stopped
    // matching after a formatting change, would make every assertion below pass
    // while checking a handful of routes or none.
    expect(served.length).toBeGreaterThanOrEqual(40);
    expect(new Set(served.map((route) => route.file)).size).toBeGreaterThanOrEqual(8);
    for (const callerClass of CALLER_CLASSES) {
      expect(
        served.filter((route) => route.callerClass === callerClass).length,
        `no route found for ${callerClass}`,
      ).toBeGreaterThan(0);
    }
  });

  it('documents every served route exactly once, and serves every documented one', () => {
    const documented = [
      ...documentedRoutes(applicationApi),
      ...documentedRoutes(reviewerApi),
      ...documentedRoutes(consoleApi),
    ];

    expect(sorted(documented.map((route) => route.signature))).toEqual(
      sorted(served.map((route) => route.signature)),
    );
  });

  /**
   * The property the API documentation is organised around, and the one a new
   * route is most likely to break: four caller classes that never substitute for
   * one another. A route added to the wrong router, or documented on the wrong
   * page, fails here by name.
   */
  it.each([
    ['api/application.md', applicationApi, ['service-credential']],
    ['api/reviewer.md', reviewerApi, ['reviewer-session']],
    ['api/console.md', consoleApi, ['console-session', 'staff-session']],
  ] as const)('%s documents only its own caller class', (_name, document, allowed) => {
    const classOf = new Map(served.map((route) => [route.signature, route.callerClass]));

    for (const route of documentedRoutes(document)) {
      expect(allowed as readonly CallerClass[], `${route.signature}`).toContain(
        classOf.get(route.signature),
      );
    }
  });

  it('names the right scope on every application route', () => {
    const scopeOf = new Map(served.map((route) => [route.signature, route.scope]));

    for (const route of documentedRoutes(applicationApi)) {
      expect(route.qualifier, `${route.signature} has no scope column`).not.toBeNull();
      expect(scopeOf.get(route.signature), `${route.signature}`).toBe(route.qualifier);
    }
  });

  /**
   * `api/README.md`'s "what is not served" list, asserted against the routing
   * table.
   *
   * This is the section with the worst failure mode in the whole tree, and it has
   * already failed once: a served/not-served list written from prose rather than
   * from `app.ts` named appeals, the reviewer history route and the console as
   * unserved when all three existed. A reader believes an absence and either
   * builds the thing that is already there or stops looking for the thing that is
   * not. So each bullet is a pattern no served route may match, and the day one
   * does the build fails instead of the page going quietly wrong.
   */
  it.each([
    ['upload route', /\/uploads?(\/|$)/],
    ['enforcement route', /\/enforcement(\/|$)/],
    ['policy or schema registry route', /\/(policy-sets|policies|resource-schemas|schemas)(\/|$)/],
    ['reputation route', /\/reputation(\/|$)/],
    ['reviewer route addressed by a case id', /^\w+ \/reviewer\/.*cases?\//],
    ['case-search route', /^GET \/cases$/],
    ['staff-role grant', /\/trust-safety\/staff/],
    ['webhook endpoint list on the application API', /^GET \/webhook-endpoints/],
  ])('is right that there is no %s', (_name, forbidden) => {
    const offenders = served
      .filter((route) => forbidden.test(route.signature))
      .map((route) => `${route.signature} (${route.file})`);

    expect(offenders, 'api/README.md says this is not served').toEqual([]);
  });

  it('mutation: the not-served patterns match what they are meant to match', () => {
    // Each pattern above is only worth anything if it would fire on the thing it
    // forbids. Proven against synthetic signatures rather than against the tree,
    // because the tree is supposed to contain none of them.
    const cases: readonly [RegExp, string][] = [
      [/\/uploads?(\/|$)/, 'POST /uploads'],
      [/\/enforcement(\/|$)/, 'POST /cases/*/enforcement'],
      [/\/(policy-sets|policies|resource-schemas|schemas)(\/|$)/, 'POST /policy-sets'],
      [/\/reputation(\/|$)/, 'POST /reputation/effects'],
      [/^\w+ \/reviewer\/.*cases?\//, 'GET /reviewer/cases/*'],
      [/^GET \/cases$/, 'GET /cases'],
      [/\/trust-safety\/staff/, 'POST /trust-safety/staff'],
      [/^GET \/webhook-endpoints/, 'GET /webhook-endpoints'],
    ];
    for (const [pattern, signature] of cases) {
      expect(pattern.test(signature), `${pattern} should match ${signature}`).toBe(true);
    }
  });

  it('mutation: a route that stopped being served, or changed guard, is caught', () => {
    const documented = documentedRoutes(applicationApi);

    const withoutOne = served.filter(
      (route) => route.signature !== documented[0].signature,
    );
    expect(sorted(withoutOne.map((route) => route.signature))).not.toEqual(
      sorted(served.map((route) => route.signature)),
    );

    const reguarded = new Map(
      served.map((route) => [
        route.signature,
        route.signature === documented[0].signature
          ? ('reviewer-session' as CallerClass)
          : route.callerClass,
      ]),
    );
    expect(reguarded.get(documented[0].signature)).not.toBe('service-credential');
  });

  it('mutation: a table parser that stopped matching is a failure, not a pass', () => {
    expect(documentedRoutes('| GET | `/v1/reports/{id}` | scope |')).toHaveLength(1);
    expect(documentedRoutes('| GET | reports | scope |')).toHaveLength(0);
    expect(documentedRoutes(applicationApi.replace(/\| GET \|/g, '| READ |')).length).toBeLessThan(
      documentedRoutes(applicationApi).length,
    );
  });
});

describe('docs/integration.md', () => {
  const claims = new ClaimReader('integration.md', integration);

  it('names the environment variables the published packages actually read', () => {
    const sdk = readFileSync(
      path.resolve(__dirname, '../../../sdk/src/client.ts'),
      'utf8',
    );
    const express = readFileSync(
      path.resolve(__dirname, '../../../sdk-express/src/middleware.ts'),
      'utf8',
    );

    expect(sdk).toContain(`SERVICE_KEY_ENV_VAR = '${claims.one('service-key-env-var')}'`);
    expect(sdk).toContain(`BASE_URL_ENV_VAR = '${claims.one('base-url-env-var')}'`);
    expect(express).toContain(
      `WEBHOOK_SECRET_ENV_VAR = '${claims.one('webhook-secret-env-var')}'`,
    );
    expect(express).toContain(
      `WEBHOOK_PREVIOUS_SECRET_ENV_VAR = '${claims.one('webhook-previous-secret-env-var')}'`,
    );
  });

  /**
   * The claim the guide is built around: the value the console shows is the HTTP
   * bearer, and `CROWDSOURCE_SERVICE_KEY` is a different, three-part string. If
   * somebody fixes the console to emit the composite — which they should — this
   * fails and the guide's workaround has to come out.
   */
  it('describes the service key the SDK actually parses', () => {
    const credential = readFileSync(
      path.resolve(__dirname, '../../../sdk/src/credential.ts'),
      'utf8',
    );
    const issuing = readFileSync(
      path.resolve(__dirname, '../modules/console/console.routes.ts'),
      'utf8',
    );

    expect(credential).toContain(
      `SERVICE_KEY_SEPARATOR = '${claims.one('service-key-separator')}'`,
    );
    expect(credential).toContain(`parts.length !== ${claims.number('service-key-parts')}`);
    expect(credential).toContain(
      `bearerToken: \`\${credentialId}${claims.one('bearer-token-separator')}\${secret}\``,
    );

    // Anchored on the issuance call, not on the first 201 in the file — the
    // organization-create route answers 201 too, and matching that one would
    // compare the guide's claim against an unrelated response.
    const issued =
      /const issued = await issueApplicationCredential\([\s\S]*?response\.status\(201\)\.json\(\{([\s\S]*?)\}\);/.exec(
        issuing,
      );
    expect(issued, 'the credential-issuing response moved').not.toBeNull();
    const fields = [...(issued?.[1] ?? '').matchAll(/^\s*(\w+)[:,]/gm)].map(
      (match) => match[1],
    );
    expect(fields.length, 'no fields parsed from the issuing response').toBeGreaterThan(0);
    expect(sorted(fields)).toEqual(sorted(claims.list('console-issued-credential-fields')));
    expect(fields, 'the console now returns an applicationId — update the guide').not.toContain(
      'applicationId',
    );
  });

  it('states the policy version a zero-configuration report is evaluated under', () => {
    expect(claims.one('default-policy-set-id')).toBe(BASELINE_POLICY_SET_ID);
    expect(claims.one('default-policy-version')).toBe(BASELINE_POLICY_VERSION);
  });

  it('states the quotas an application actually gets', () => {
    expect(sorted(claims.list('application-standings'))).toEqual(sorted(APPLICATION_STANDINGS));
    expect(claims.number('sandbox-reports-per-day')).toBe(QUOTAS_BY_STANDING.sandbox.reportsPerDay);
    expect(claims.number('sandbox-webhook-endpoints')).toBe(
      QUOTAS_BY_STANDING.sandbox.webhookEndpoints,
    );
    expect(claims.number('trusted-reports-per-day')).toBe(QUOTAS_BY_STANDING.trusted.reportsPerDay);
    expect(claims.number('restricted-reports-per-day')).toBe(
      QUOTAS_BY_STANDING.restricted.reportsPerDay,
    );
  });

  it('leaves no claim unchecked', () => claims.assertEveryClaimWasChecked());
});

describe('docs/api/application.md', () => {
  const claims = new ClaimReader('api/application.md', applicationApi);

  it('lists the scopes an application may and may not be granted', () => {
    expect(sorted(claims.list('application-scopes'))).toEqual(sorted(APPLICATION_SCOPES));
    expect(sorted(claims.list('privileged-scopes'))).toEqual(sorted(PRIVILEGED_SCOPES));
  });

  it('lists the vocabularies a client branches on', () => {
    expect(sorted(claims.list('decision-outcomes'))).toEqual(sorted(DECISION_OUTCOMES));
    expect(sorted(claims.list('report-statuses'))).toEqual(sorted(REPORT_STATUSES));
    expect(sorted(claims.list('appealable-outcomes'))).toEqual(sorted(APPEALABLE_OUTCOMES));
    expect(sorted(claims.list('appeal-reasons'))).toEqual(sorted(APPEAL_REASONS));
    expect(sorted(claims.list('error-codes'))).toEqual(sorted(Object.keys(API_ERROR_STATUS)));
    expect(sorted(claims.list('ingress-refusal-reasons'))).toEqual(sorted(AUDIT_REASONS));
    expect(sorted(claims.list('decision-finding-fields'))).toEqual(
      sorted(Object.keys(DecisionFindingSchema.shape)),
    );
  });

  /**
   * The evidence gap, asserted as an ABSENCE. The document says nothing copies
   * evidence bytes into storage CrowdSource controls; the day a second file
   * appears in that module, this fails and the claim gets re-read rather than
   * quietly outliving the gap it describes.
   */
  it('is right that the evidence module holds only the content snapshot', () => {
    const files = readdirSync(path.resolve(__dirname, '../modules/evidence'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    expect(files.length, 'the evidence module is empty — the scan is wrong').toBeGreaterThan(0);
    expect(sorted(files)).toEqual(sorted(claims.list('evidence-module-files')));
  });

  it('leaves no claim unchecked', () => claims.assertEveryClaimWasChecked());
});

describe('docs/api/reviewer.md', () => {
  const claims = new ClaimReader('api/reviewer.md', reviewerApi);

  it('lists what a reviewer may answer', () => {
    expect(sorted(claims.list('review-outcomes'))).toEqual(sorted(REVIEW_OUTCOMES));
    expect(sorted(claims.list('recusal-reasons'))).toEqual(sorted(RECUSAL_REASONS));
    expect(sorted(claims.list('context-sufficiencies'))).toEqual(sorted(CONTEXT_SUFFICIENCIES));
    expect(claims.one('assignment-token-header')).toBe(ASSIGNMENT_TOKEN_HEADER);
  });

  /**
   * `inconclusive` is produced by the engine and never voted for. Stated as its
   * own assertion because the whole "absence of consensus is neither guilt nor
   * innocence" property rests on it, and a widened review enum would read as a
   * harmless addition.
   */
  it('is right that a reviewer cannot vote inconclusive', () => {
    expect(claims.list('review-outcomes')).not.toContain('inconclusive');
    expect(REVIEW_OUTCOMES as readonly string[]).not.toContain('inconclusive');
    expect(DECISION_OUTCOMES as readonly string[]).toContain('inconclusive');
  });

  it('leaves no claim unchecked', () => claims.assertEveryClaimWasChecked());
});

describe('docs/api/webhooks.md', () => {
  const claims = new ClaimReader('api/webhooks.md', webhooksApi);

  it('lists the event catalogue, and which of it is wired', () => {
    expect(sorted(claims.list('webhook-event-types'))).toEqual(sorted(WEBHOOK_EVENT_TYPES));

    const wired = claims.list('wired-webhook-events');
    expect(sorted(wired)).toEqual(sorted(webhookSourcedEventTypes()));
    // The wired set is named in the outbox's vocabulary; every entry must also
    // be a real webhook event type, or the table's "yes" column is a fiction.
    for (const type of wired) {
      expect(WEBHOOK_EVENT_TYPES as readonly string[]).toContain(type);
    }
    expect(wired.length).toBeLessThan(WEBHOOK_EVENT_TYPES.length);
  });

  it('states the signature and retry contract a receiver plans around', () => {
    expect(claims.list('retry-schedule-seconds').map(Number)).toEqual([
      ...WEBHOOK_RETRY_SCHEDULE_SECONDS,
    ]);
    expect(claims.number('webhook-max-attempts')).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(claims.number('webhook-client-error-max-attempts')).toBe(
      WEBHOOK_CLIENT_ERROR_MAX_ATTEMPTS,
    );
    expect(claims.number('webhook-timestamp-tolerance-seconds')).toBe(
      WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    );
    expect(claims.one('webhook-signature-version')).toBe(WEBHOOK_SIGNATURE_VERSION);
    expect(claims.list('webhook-headers')).toEqual([
      WEBHOOK_EVENT_ID_HEADER,
      WEBHOOK_TIMESTAMP_HEADER,
      WEBHOOK_SIGNATURE_HEADER,
    ]);
  });

  it('leaves no claim unchecked', () => claims.assertEveryClaimWasChecked());
});

describe('docs/policies/README.md', () => {
  const claims = new ClaimReader('policies/README.md', policies);

  it('describes the taxonomy that is actually published', () => {
    expect(claims.one('taxonomy-version')).toBe(UNIVERSAL_TAXONOMY_VERSION);
    expect(claims.number('taxonomy-code-count')).toBe(UNIVERSAL_TAXONOMY_CODES.length);
    expect(sorted(claims.list('taxonomy-families'))).toEqual(sorted(TAXONOMY_FAMILIES));
    expect(sorted(claims.list('severities'))).toEqual(sorted(SEVERITIES));
    expect(sorted(claims.list('finding-contexts'))).toEqual(sorted(FINDING_CONTEXTS));
    expect(sorted(claims.list('finding-scopes'))).toEqual(sorted(FINDING_SCOPES));
    expect(claims.number('recommended-action-count')).toBe(RECOMMENDED_ACTIONS.length);
  });

  it('describes the outcomes a juror and an engine may reach', () => {
    expect(sorted(claims.list('review-outcomes'))).toEqual(sorted(REVIEW_OUTCOMES));
    expect(sorted(claims.list('decision-outcomes'))).toEqual(sorted(DECISION_OUTCOMES));
    expect(sorted(claims.list('appealable-outcomes'))).toEqual(sorted(APPEALABLE_OUTCOMES));
  });

  it('describes the baseline policy set that ships', () => {
    expect(claims.one('baseline-policy-set-id')).toBe(BASELINE_POLICY_SET_ID);
    expect(claims.one('baseline-policy-version')).toBe(BASELINE_POLICY_VERSION);
    expect(claims.one('oxy-conduct-policy-version')).toBe(OXY_CONDUCT_POLICY_VERSION);
    expect(claims.list('baseline-rule-ids')).toEqual(
      BASELINE_POLICY_SET.rules.map((rule) => rule.id),
    );
    // One rule per family, which is what the document's table claims.
    expect(BASELINE_POLICY_SET.rules).toHaveLength(TAXONOMY_FAMILIES.length);
  });

  /**
   * The stated gap: a policy version has no field for worked examples. Asserted
   * against the schema's own shape, so the day somebody adds one this fails and
   * the "gap" section has to come out rather than sit there being wrong.
   */
  it('is right that a policy rule cannot carry examples', () => {
    const ruleShape = Object.keys(PolicyRuleSchema.shape);
    const policySetShape = Object.keys(PolicySetVersionSchema.shape);
    expect(ruleShape.length, 'the rule shape could not be read').toBeGreaterThan(0);
    expect(policySetShape.length, 'the policy-set shape could not be read').toBeGreaterThan(0);

    expect(sorted(claims.list('policy-rule-fields'))).toEqual(sorted(ruleShape));
    expect(sorted(claims.list('policy-set-version-fields'))).toEqual(sorted(policySetShape));

    /**
     * And the same claim behaviourally, because a field list is a statement
     * about a shape while what the document promises is that a tenant CANNOT
     * express examples. Both schemas are strict, so the extra key is rejected —
     * if either were ever loosened, the field-list assertions above would still
     * pass and this would not.
     */
    const withExamples = {
      ...BASELINE_POLICY_SET,
      examples: [{ text: 'this counts' }],
    };
    expect(PolicySetVersionSchema.safeParse(withExamples).success).toBe(false);
    expect(
      PolicySetVersionSchema.safeParse({
        ...BASELINE_POLICY_SET,
        rules: BASELINE_POLICY_SET.rules.map((rule) => ({ ...rule, examples: ['x'] })),
      }).success,
    ).toBe(false);
    expect(
      PolicySetVersionSchema.safeParse(BASELINE_POLICY_SET).success,
      'the unmutated baseline must still parse, or the check above proves nothing',
    ).toBe(true);
  });

  it('describes the routing and the thresholds a juror is held to', () => {
    expect(sorted(claims.list('sensitivity-classes'))).toEqual(sorted(SENSITIVITY_CLASSES));
    expect(sorted(claims.list('review-pools'))).toEqual(sorted(REVIEW_POOLS));

    expect(claims.list('minimum-agreeing-votes')).toEqual(
      Object.entries(MINIMUM_AGREEING_VOTES).map(([risk, votes]) => `${risk}=${votes}`),
    );
    expect(claims.list('round-agreeing-votes')).toEqual(
      Object.entries(ROUND_AGREEING_VOTES).map(([round, votes]) => `${round}=${votes}`),
    );
  });

  it('leaves no claim unchecked', () => claims.assertEveryClaimWasChecked());
});

describe('docs/runbooks/webhook-dead-letters.md', () => {
  const claims = new ClaimReader('runbooks/webhook-dead-letters.md', deadLetters);

  it('names every reason an operator will read off a row', () => {
    expect(sorted(claims.list('dead-letter-reasons'))).toEqual(
      sorted(WEBHOOK_DEAD_LETTER_REASONS),
    );
    expect(sorted(claims.list('failure-kinds'))).toEqual(sorted(WEBHOOK_FAILURE_KINDS));
    expect(claims.number('delivery-lease-ms')).toBe(WEBHOOK_DELIVERY_LEASE_MS);
  });

  it('names the role the cross-tenant dead-letter queue actually requires', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../modules/console/trustSafety.routes.ts'),
      'utf8',
    );
    const guard =
      /'\/trust-safety\/deliveries\/dead-letter',\s*\n?\s*\.\.\.requireStaffRole\(([^)]*)\)/.exec(
        source,
      );
    expect(guard, 'the dead-letter route moved').not.toBeNull();
    expect(
      [...(guard?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]),
    ).toEqual([claims.one('staff-dead-letter-role')]);
  });

  it('leaves no claim unchecked', () => claims.assertEveryClaimWasChecked());
});

describe('docs/runbooks/outbox-backlog.md', () => {
  const claims = new ClaimReader('runbooks/outbox-backlog.md', outbox);

  it('describes the outbox that exists', () => {
    expect(sorted(claims.list('outbox-statuses'))).toEqual(sorted(OUTBOX_STATUSES));
    expect(claims.number('outbox-max-attempts')).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(claims.number('outbox-lease-ms')).toBe(OUTBOX_LEASE_MS);
    expect(sorted(claims.list('outbox-event-types'))).toEqual(
      sorted(Object.values(OUTBOX_EVENT_TYPES)),
    );
  });

  /**
   * Two absences the runbook rests on. Both would be actively harmful to leave
   * stated once they stop being true: an operator told there is no queue would
   * not look for one, and an operator told cross-tenant correlation does not
   * exist would not look for an incident.
   */
  it('is right that there is no queue dependency', () => {
    expect(claims.one('no-queue-dependency')).toBe('true');

    const manifest: { dependencies?: Record<string, string> } = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
    );
    const dependencies = Object.keys(manifest.dependencies ?? {});
    expect(dependencies.length, 'the manifest has no dependencies — the read is wrong').toBeGreaterThan(0);
    for (const queue of ['bullmq', 'ioredis', 'redis', 'amqplib', '@aws-sdk/client-sqs']) {
      expect(dependencies, `a queue arrived: ${queue}`).not.toContain(queue);
    }
    expect(Object.keys(config)).not.toContain('redis');
  });

  it('is right that there is no Incident module', () => {
    expect(claims.one('no-incident-module')).toBe('true');

    const modules = readdirSync(routesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(modules.length, 'no modules found — the scan is wrong').toBeGreaterThan(10);
    expect(modules.map((name) => name.toLowerCase())).not.toContain('incident');
  });

  it('leaves no claim unchecked', () => claims.assertEveryClaimWasChecked());
});

describe('docs/runbooks/case-cannot-empanel.md', () => {
  const claims = new ClaimReader('runbooks/case-cannot-empanel.md', empanel);

  it('names every reason a draw row can carry', () => {
    expect(sorted(claims.list('draw-statuses'))).toEqual(sorted(DRAW_STATUSES));
    expect(sorted(claims.list('draw-kinds'))).toEqual(sorted(DRAW_KINDS));
    expect(sorted(claims.list('panel-refusal-reasons'))).toEqual(sorted(PANEL_REFUSAL_REASONS));
    expect(sorted(claims.list('eligibility-rejections'))).toEqual(sorted(ELIGIBILITY_REJECTIONS));
    expect(sorted(claims.list('exclusion-reasons'))).toEqual(sorted(EXCLUSION_REASONS));
    expect(claims.one('sortition-rules-version')).toBe(SORTITION_RULES_VERSION);
  });

  it('describes the panels a draw is asked to fill', () => {
    expect(sorted(claims.list('slot-types'))).toEqual(sorted(SLOT_TYPES));
    expect(claims.list('community-round-seats').map(Number)).toEqual(
      [1, 2, 3].map((round) => panelSpecFor('community', round, false).slots.length),
    );
    expect(claims.list('specialist-round-seats').map(Number)).toEqual(
      [1, 2, 3].map((round) => panelSpecFor('specialist', round, false).slots.length),
    );
    expect(claims.number('candidate-sample-size')).toBe(config.sortition.candidateSampleSize);
  });

  it('leaves no claim unchecked', () => claims.assertEveryClaimWasChecked());
});

describe('docs/runbooks/audit-trails.md', () => {
  const claims = new ClaimReader('runbooks/audit-trails.md', auditTrails);

  it('names both trails, and every action each records', () => {
    expect(sorted(claims.list('audit-actions'))).toEqual(sorted(AUDIT_ACTIONS));
    expect(sorted(claims.list('audit-reasons'))).toEqual(sorted(AUDIT_REASONS));
    expect(sorted(claims.list('staff-audit-actions'))).toEqual(sorted(STAFF_AUDIT_ACTIONS));
    expect(sorted(claims.list('staff-roles'))).toEqual(sorted(STAFF_ROLES));
    expect(sorted(claims.list('console-seats'))).toEqual(sorted(CONSOLE_ROLES));
  });

  it('names the two collections correctly, and they are two', () => {
    const tenantTrail = readFileSync(
      path.resolve(__dirname, '../modules/audit/audit.collection.ts'),
      'utf8',
    );
    const staffTrail = readFileSync(
      path.resolve(__dirname, '../modules/console/staffAudit.collection.ts'),
      'utf8',
    );

    expect(tenantTrail).toContain(`collection: '${claims.one('audit-collection')}'`);
    expect(staffTrail).toContain(`collection: '${claims.one('staff-audit-collection')}'`);
    expect(claims.one('audit-collection')).not.toBe(claims.one('staff-audit-collection'));
  });

  /**
   * Both trails are append-only "by construction", which means by there being no
   * update or delete in either module. That is a property a single careless line
   * removes, and the documentation would go on claiming it.
   */
  it('is right that neither trail is ever updated or deleted', () => {
    for (const file of [
      '../modules/audit/audit.collection.ts',
      '../modules/console/staffAudit.collection.ts',
    ]) {
      const source = readFileSync(path.resolve(__dirname, file), 'utf8');
      const writes = [...source.matchAll(/\.(insertOne|updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate)\(/g)]
        .map((match) => match[1]);

      expect(writes.length, `${file}: no writes found — the scan is wrong`).toBeGreaterThan(0);
      expect(sorted(new Set(writes)), file).toEqual(['insertOne']);
    }
  });

  it('leaves no claim unchecked', () => claims.assertEveryClaimWasChecked());
});

describe('the claims parser itself', () => {
  it('mutation: a claim that drifted from the code is caught, and named', () => {
    const drifted = policies
      .replace('taxonomy-version: 2026.1', 'taxonomy-version: 2027.9')
      .replace(`taxonomy-code-count: ${UNIVERSAL_TAXONOMY_CODES.length}`, 'taxonomy-code-count: 4');

    const mutated = parseClaims(drifted);
    expect(mutated.get('taxonomy-version')?.[0]).not.toBe(UNIVERSAL_TAXONOMY_VERSION);
    expect(Number(mutated.get('taxonomy-code-count')?.[0])).not.toBe(
      UNIVERSAL_TAXONOMY_CODES.length,
    );
  });

  it('mutation: a block that lost its fence, or its contents, is a failure', () => {
    expect(() => parseClaims(policies.replace('```docs-claims', '```text'))).toThrow(
      /no fenced `docs-claims` block/,
    );
    expect(() => parseClaims('```docs-claims\nnot a claim line\n```')).toThrow(/not 'key: value'/);
    expect(() => parseClaims('```docs-claims\n\n```')).toThrow(/empty/);
  });

  it('mutation: an unread claim fails the vacuity floor', () => {
    const reader = new ClaimReader(
      'synthetic',
      '```docs-claims\nchecked: a\nforgotten: b\n```',
    );
    reader.list('checked');
    expect(() => reader.assertEveryClaimWasChecked()).toThrow();
  });
});
