/**
 * The fictional application, and the storage façade its tests reach it through.
 *
 * Everything here is backend-NEUTRAL by construction. The suite asserts the
 * guarantees in §2 — a report and its outbox row commit together, a lease is
 * owned, an enforcement action happens once — and every one of those is a claim
 * about behaviour rather than about a driver. A test body that says
 * `countDocuments({})` or `new mongoose.Types.ObjectId()` is making the same
 * claim in a dialect only one backend speaks, and that is the whole reason this
 * file exists: a second implementation of {@link ModerationBackend} makes the
 * identical suite run against Postgres without touching a test body.
 *
 * The rule that keeps it honest: **there is no escape hatch.** No `connection`,
 * no model, no `db`. If a test needs something the façade cannot express, the
 * façade is what changes — because an escape hatch is precisely what the second
 * backend cannot implement, and discovering that in Task 11 costs a rewrite of
 * whichever test used it.
 */

import type { Decision, TaxonomyCode } from '@oxyhq/crowdsource-contracts';
import type {
  EnforcementPreviousState,
  ModerationEnforcementConfig,
  ModerationEnforcementMode,
  ModerationLogger,
  ModerationOutboxEvent,
  ModerationOutboxKind,
  ModerationOutboxPayload,
  ModerationOutboxStatus,
  ModerationReportFields,
  ModerationSubjectProvider,
} from '../../types.js';
import type { ModerationIntegration } from '../../integration.js';
import type { ReviewOnlyHarness } from './reviewOnlyApplication.js';

/* ------------------------------------------------------------------------- */
/* The fictional application                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The application's report, as both backends store it.
 *
 * `id` comes from {@link ModerationReportFields}, so nothing here names a
 * primary key. `legacyStatus` is the verdict field an application had before it
 * adopted CrowdSource, which is what exercises the extra-fields escape hatch.
 */
export interface TestReport extends ModerationReportFields {
  legacyStatus: string;
}

export type TestAction = 'restrict' | 'restore' | 'flag' | 'unflag' | 'review' | 'none';

export const TEST_ACTIONS: readonly TestAction[] = [
  'restrict',
  'restore',
  'flag',
  'unflag',
  'review',
  'none',
];

/** The two things a widget has that moderation can change. */
export interface TestWidgetState {
  status: string;
  flagged: boolean;
}

/* ------------------------------------------------------------------------- */
/* The half of the fictional application that has no driver in it              */
/* ------------------------------------------------------------------------- */

/**
 * These four are shared by both backends verbatim.
 *
 * A logger, a category mapping, a deliverable noun with no enforcement lever, and
 * the legacy-verdict derivation — none of them touches storage, so a second copy
 * per backend would be two chances for the fictional application to stop being
 * one application. What each backend DOES supply for itself is the pair that
 * reads and writes rows: the widget subject provider and the enforcement `apply`.
 */

export const recordingLogger = (
  sink: Harness['logs'],
): ModerationLogger => ({
  info: (message, context) => void sink.push({ level: 'info', message, ...(context ? { context } : {}) }),
  warn: (message, context) => void sink.push({ level: 'warn', message, ...(context ? { context } : {}) }),
  error: (message, context) => void sink.push({ level: 'error', message, ...(context ? { context } : {}) }),
});

const CATEGORY_TO_ALLEGATION: Readonly<Record<string, TaxonomyCode>> = Object.freeze({
  spam: 'integrity.spam',
  harassment: 'harassment.targeted_abuse',
  other: 'other.unclassifiable',
});

export function testTaxonomy(): {
  version: string;
  allegationsFor(categories: readonly string[]): readonly TaxonomyCode[];
} {
  return {
    version: '2026.07',
    allegationsFor(categories) {
      const codes = new Set<TaxonomyCode>();
      for (const category of categories) {
        codes.add(CATEGORY_TO_ALLEGATION[category] ?? 'other.unclassifiable');
      }
      return Array.from(codes).sort();
    },
  };
}

export function doodadSubjectProvider(): ModerationSubjectProvider {
  return {
    reportedType: 'doodad',
    subjectType: 'custom.test.doodad',
    async snapshot(reportedId) {
      return {
        subject: { externalId: reportedId, type: 'custom.test.doodad' },
        content: { type: 'text', data: { text: 'a reported doodad' } },
      };
    },
  };
}

export function legacyStatusFor(decision: Decision): { legacyStatus: string } {
  switch (decision.outcome) {
    case 'violation':
      return { legacyStatus: 'resolved' };
    case 'no_violation':
      return { legacyStatus: 'dismissed' };
    default:
      return { legacyStatus: 'reviewed' };
  }
}

/* ------------------------------------------------------------------------- */
/* Rows, as the façade returns them                                           */
/* ------------------------------------------------------------------------- */

/**
 * An outbox row.
 *
 * Absent values are `null` rather than `undefined`, deliberately: Mongo omits a
 * `$unset` field and Postgres stores a NULL, so a suite that asserted
 * `toBeUndefined()` would pass on one backend and fail on the other while the
 * behaviour was identical. One shape, one assertion.
 */
export interface HarnessOutboxRow {
  id: string;
  kind: ModerationOutboxKind;
  status: ModerationOutboxStatus;
  attempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  lastError: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** An enforcement row. Same `null` rule as {@link HarnessOutboxRow}. */
export interface HarnessEnforcementRow {
  decisionId: string;
  decisionRevision: number;
  action: string;
  recordedAs: string | null;
  applied: boolean;
  appliedAt: Date | null;
  skippedReason: string | null;
  previousState: EnforcementPreviousState | null;
  mode: ModerationEnforcementMode;
  createdAt: Date;
}

/** Enqueue an outbox event on whatever transaction handle is currently open. */
export type HarnessEnqueue = (input: {
  eventId: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
}) => Promise<void>;

/* ------------------------------------------------------------------------- */
/* The façade                                                                 */
/* ------------------------------------------------------------------------- */

/** The fictional application's own state, which moderation acts upon. */
export interface HarnessApp {
  createWidget(input: {
    body: string;
    ownerId: string;
    status?: 'draft' | 'published' | 'restricted';
  }): Promise<string>;
  readWidget(id: string): Promise<TestWidgetState | null>;
  readReport(id: string): Promise<TestReport | null>;
  countReports(): Promise<number>;
  /**
   * A well-formed id for a row that does not exist — ObjectId hex on Mongo, uuid
   * v7 on Postgres.
   *
   * WELL-FORMED is the point. A test needing "an id nothing matches" must not
   * hand over a string one backend refuses to parse, because then it is testing
   * the parser rather than the absence.
   */
  absentId(): string;
}

export interface HarnessOutbox {
  count(filter?: {
    kind?: ModerationOutboxKind;
    status?: ModerationOutboxStatus;
  }): Promise<number>;
  read(eventId: string): Promise<HarnessOutboxRow | null>;
  /**
   * Overwrite the lease owner out of band, to simulate another task.
   *
   * **Bounded, and the bound is load-bearing rather than tuning.** This write is
   * used while a transaction on the same row is open, so it can BLOCK. Unbounded,
   * the observation has no stable verdict: the same defect on the same topology
   * has produced an abort, a clean pass, and an 88-second hang until the runner
   * timed out — and a failure mode of "hang" cannot tell a broken guard from a
   * slow box. Every implementation must therefore fail fast and by name.
   */
  stealLease(eventId: string, leaseOwner: string): Promise<void>;
  /**
   * Claim one due event and complete it. The POLICY-level API, not the store's:
   * backoff, the lease length and the retry ceiling are computed by the shared
   * half, so these two are neutral without any per-backend work.
   */
  claim(options: { leaseOwner: string }): Promise<ModerationOutboxEvent | null>;
  complete(eventId: string, leaseOwner: string): Promise<boolean>;
  /**
   * Make every enqueue throw until `restore()` is called.
   *
   * Injected at the STORE the integration actually holds, which is the only
   * place it is observable from inside `createReport` — the point being to prove
   * the report is rolled back with the outbox row rather than left behind.
   */
  breakEnqueue(message: string): { restore(): void };
}

export interface HarnessEvents {
  count(filter?: { state?: 'claimed' | 'queued' | 'ignored' }): Promise<number>;
}

export interface HarnessEnforcement {
  /** Every enforcement row, `createdAt` ASCENDING. */
  rows(): Promise<HarnessEnforcementRow[]>;
}

export interface HarnessTransaction {
  /**
   * Run a callback inside a REAL transaction on this backend, handing it an
   * enqueue already bound to that transaction's handle.
   *
   * The handle itself never crosses this boundary. A mongoose `ClientSession`
   * and a drizzle transaction are different types, and one `Harness` cannot name
   * both without a type parameter — which a single `describe.each` over two
   * backends cannot tolerate. Binding the enqueue is what removes the need.
   *
   * A throw from the callback MUST propagate, because two tests assert that the
   * transaction rolled back and a swallowed error would make both of them pass
   * against a commit.
   */
  run(operation: (enqueue: HarnessEnqueue) => Promise<void>): Promise<void>;
}

export interface Harness {
  moderation: ModerationIntegration<TestReport, TestAction>;
  logs: { level: string; message: string; context?: Record<string, unknown> }[];

  app: HarnessApp;
  outbox: HarnessOutbox;
  events: HarnessEvents;
  enforcement: HarnessEnforcement;
  transaction: HarnessTransaction;

  /**
   * An enqueue bound to a handle that is NOT in a transaction — a bare mongoose
   * session, or the Postgres pool handle.
   *
   * The negative case for the enqueue guard, and the only reason this is on the
   * harness at all: the guard exists because a handle that satisfies the
   * required parameter without an open transaction type-checks perfectly and
   * commits the row on its own.
   */
  detachedEnqueue(): Promise<{ enqueue: HarnessEnqueue; dispose(): Promise<void> }>;

  close(): Promise<void>;
}

export interface HarnessOptions {
  enabled?: boolean;
  serviceKey?: string;
  baseUrl?: string;
  webhookSecret?: string;
  enforcementMode?: 'observe' | 'manual' | 'automatic';
  subjects?: readonly ModerationSubjectProvider[];
  /** Replaces the application's whole enforcement half, `apply` included. */
  enforcement?: ModerationEnforcementConfig<TestAction>;
}

/**
 * One storage backend, as the suite sees it.
 *
 * TWO factories, because there are two fictional applications: the one with
 * levers, and the one with nothing to enforce with. Both are storage shapes a
 * backend has to be able to build, so both live here rather than one being
 * reached through a side door.
 */
export interface ModerationBackend {
  readonly name: 'mongoose' | 'postgres';
  createHarness(options?: HarnessOptions): Promise<Harness>;
  createReviewOnlyHarness(): Promise<ReviewOnlyHarness>;
}
