/**
 * Replayable copies of decision inputs (mission "Decision model evals", step 1).
 *
 * The decision ledgers (`decision_records`, `orchestration_decisions`) keep what
 * was decided, never what was asked: a fingerprint of the input, not the input.
 * An eval that wants to ask Clef, Clef Flash or a chat model the same question
 * Jev was asked needs the question as it stood at that moment (a claim
 * decision depends on what else was running then), so this module keeps a copy.
 *
 * - **Where:** in the team's evidence backend (team bucket, else the
 *   buildd-managed one), through a store apps/web registers at boot
 *   (`registerDecisionReplayStore`). Core declares the hook; it never imports
 *   the storage module (scripts/module-boundaries.ts).
 * - **Keyed by** the ledger row id, under the row's capability and UTC day, so
 *   the ledger is the index: `listReplayableDecisions` reads the ledger and
 *   `loadDecisionReplay` drops any id with no stored copy.
 * - **Never slows or fails a decision.** Capture runs after the ledger row is
 *   written, deferred, bounded (size, per-kind daily cap, sampling) and every
 *   failure is a warning.
 * - **What is stored:** the state the model saw (or a kind's features), the
 *   question ids, the candidates, the rule's answer, and a reference to the
 *   prompt version (id, version, content hash), never private prompt text: an
 *   eval resolves the text by that reference, so a prompt changed since still
 *   replays as it was asked. The store redacts secrets and skips sensitive
 *   workspaces; objects expire with the backend's retention.
 */

/** Which ledger the decision id belongs to. */
export type DecisionReplaySource = 'decision_records' | 'orchestration_decisions';

export interface DecisionPromptRef {
  /** The prompt or decision definition id (a kind id, or an orchestration decision id). */
  id: string;
  version: string | null;
  contentHash: string | null;
}

/** What a call site hands over; the ledger write adds the identity. */
export interface DecisionReplayCapture {
  /** The state the model was asked with: decision text, or a kind's parsed features. */
  state: unknown;
  questionIds: string[];
  candidates?: string[] | null;
  promptRef?: DecisionPromptRef | null;
  /** A kind's feature schema version, when `state` is features. */
  featureSchemaVersion?: string | null;
}

/** One stored input, as an eval reads it back. */
export interface DecisionReplayInput {
  capability: string;
  decisionId: string;
  /** The model that answered, or the one routed to when nothing answered. */
  model: string | null;
  promptRef: DecisionPromptRef | null;
  state: unknown;
  questionIds: string[];
  candidates: string[] | null;
  ruleAnswer: string | null;
  /** ISO timestamp of the ledger row. */
  askedAt: string;
  source: DecisionReplaySource;
  featureSchemaVersion: string | null;
}

/** Where the copy lives. Everything the store needs to place and find an object. */
export interface DecisionReplayLocator {
  teamId: string;
  workspaceId: string | null;
  capability: string;
  decisionId: string;
  askedAt: Date;
}

export interface DecisionReplayStore {
  /** Write one copy. May skip (sensitive workspace, no usable backend). Should not throw; a throw is caught. */
  put(locator: DecisionReplayLocator, input: DecisionReplayInput): Promise<'stored' | 'skipped'>;
  /** Read one copy; null when absent, expired or unreadable. */
  get(locator: DecisionReplayLocator): Promise<DecisionReplayInput | null>;
  /** Run a job after the response (e.g. Next's `after`). Default: fire and forget. */
  defer?(job: () => Promise<void>): void;
}

// On globalThis: Next bundles instrumentation.ts apart from route handlers, so
// this module can load more than once per process; every copy sees one store.
const STORE_KEY = Symbol.for('buildd.decision-replay.store');
type StoreHolder = { [STORE_KEY]?: DecisionReplayStore | null };

/** Install the store (apps/web, at boot). Passing null turns capture off. */
export function registerDecisionReplayStore(next: DecisionReplayStore | null): void {
  (globalThis as StoreHolder)[STORE_KEY] = next;
}

export function getDecisionReplayStore(): DecisionReplayStore | null {
  return (globalThis as StoreHolder)[STORE_KEY] ?? null;
}

// ── Capture ──────────────────────────────────────────────────────────────────

/** A state larger than this (serialized) is not kept: it would be a log, not a decision input. */
export const MAX_REPLAY_STATE_CHARS = 256 * 1024;
/** Per team and capability per UTC day, per process. */
export const DEFAULT_REPLAY_DAILY_CAP = 2000;

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Fraction of decisions kept, per capability: `DECISION_REPLAY_SAMPLE_<CAPABILITY>` else `DECISION_REPLAY_SAMPLE`, default 1. */
export function replaySampleRate(capability: string): number {
  const specific = `DECISION_REPLAY_SAMPLE_${capability.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return envNumber(specific, envNumber('DECISION_REPLAY_SAMPLE', 1, 0, 1), 0, 1);
}

export function replayDailyCap(): number {
  return envNumber('DECISION_REPLAY_DAILY_CAP', DEFAULT_REPLAY_DAILY_CAP, 0, 1_000_000);
}

const counters = new Map<string, number>();

/** Test hook. */
export function resetReplayCounters(): void {
  counters.clear();
}

function underCap(teamId: string, capability: string, at: Date, cap: number): boolean {
  const key = `${teamId}|${capability}|${at.toISOString().slice(0, 10)}`;
  const n = counters.get(key) ?? 0;
  if (n >= cap) return false;
  counters.set(key, n + 1);
  // One day of keys per process is plenty; drop yesterday's.
  if (counters.size > 10_000) counters.clear();
  return true;
}

function stateSize(state: unknown): number {
  try {
    return typeof state === 'string' ? state.length : JSON.stringify(state)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

export interface CaptureInput extends DecisionReplayCapture {
  decisionId: string;
  source: DecisionReplaySource;
  teamId: string;
  workspaceId: string | null;
  capability: string;
  model: string | null;
  ruleAnswer: string | null;
  askedAt: Date;
}

export type CaptureResult = 'scheduled' | 'no_store' | 'sampled_out' | 'capped' | 'too_large' | 'invalid';

export interface CaptureDeps {
  store?: DecisionReplayStore | null;
  random?: () => number;
  cap?: number;
}

/**
 * Schedule one copy. Returns at once with what it did; the write itself runs
 * deferred and its failure is a warning. Never throws.
 */
export function captureDecisionReplay(input: CaptureInput, deps: CaptureDeps = {}): CaptureResult {
  try {
    const target = deps.store === undefined ? getDecisionReplayStore() : deps.store;
    if (!target) return 'no_store';
    if (!input.decisionId || !input.teamId || !input.capability || input.state === undefined || input.state === null) return 'invalid';
    if ((deps.random ?? Math.random)() >= replaySampleRate(input.capability)) return 'sampled_out';
    if (stateSize(input.state) > MAX_REPLAY_STATE_CHARS) return 'too_large';
    if (!underCap(input.teamId, input.capability, input.askedAt, deps.cap ?? replayDailyCap())) return 'capped';

    const locator: DecisionReplayLocator = {
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      capability: input.capability,
      decisionId: input.decisionId,
      askedAt: input.askedAt,
    };
    const record: DecisionReplayInput = {
      capability: input.capability,
      decisionId: input.decisionId,
      model: input.model,
      promptRef: input.promptRef ?? null,
      state: input.state,
      questionIds: [...input.questionIds],
      candidates: input.candidates ? [...input.candidates] : null,
      ruleAnswer: input.ruleAnswer,
      askedAt: input.askedAt.toISOString(),
      source: input.source,
      featureSchemaVersion: input.featureSchemaVersion ?? null,
    };
    const job = async () => {
      try {
        await target.put(locator, record);
      } catch (err) {
        console.warn(`[decision-replay] write failed for ${input.capability} (non-fatal):`, (err as Error)?.message ?? err);
      }
    };
    if (target.defer) target.defer(job);
    else void job();
    return 'scheduled';
  } catch (err) {
    console.warn('[decision-replay] capture skipped (non-fatal):', (err as Error)?.message ?? err);
    return 'invalid';
  }
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** One ledger row, as much as replay needs. */
export interface ReplayLedgerRow {
  decisionId: string;
  teamId: string;
  workspaceId: string | null;
  capability: string;
  createdAt: Date;
}

export interface ReplayReadDeps {
  store?: DecisionReplayStore | null;
  /** Ledger rows for these ids, any team (filtered here). */
  lookupLedger?: (ids: string[]) => Promise<ReplayLedgerRow[]>;
  /** Ledger rows a model was asked for, newest first. */
  listLedger?: (opts: { teamId: string; capability?: string; since: Date; limit: number }) => Promise<ReplayLedgerRow[]>;
}

export const MAX_REPLAY_LIST = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The stored inputs for these ledger ids, in the caller's team only. An id
 * from another team, with no stored copy, or whose copy expired is absent from
 * the map, never an error.
 */
export async function loadDecisionReplay(
  opts: { teamId: string; decisionIds: string[] },
  deps: ReplayReadDeps = {},
): Promise<Map<string, DecisionReplayInput>> {
  const out = new Map<string, DecisionReplayInput>();
  const target = deps.store === undefined ? getDecisionReplayStore() : deps.store;
  const ids = [...new Set(opts.decisionIds.filter(id => UUID_RE.test(id)))].slice(0, MAX_REPLAY_LIST);
  if (!target || ids.length === 0) return out;
  const rows = await (deps.lookupLedger ?? dbLookupLedger)(ids);
  const own = rows.filter(r => r.teamId === opts.teamId);
  const CONCURRENCY = 8;
  for (let i = 0; i < own.length; i += CONCURRENCY) {
    const batch = own.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map(async r => {
      try {
        return await target.get({ teamId: r.teamId, workspaceId: r.workspaceId, capability: r.capability, decisionId: r.decisionId, askedAt: r.createdAt });
      } catch (err) {
        console.warn('[decision-replay] read failed (treated as absent):', (err as Error)?.message ?? err);
        return null;
      }
    }));
    batch.forEach((r, j) => {
      const input = got[j];
      if (input && input.decisionId === r.decisionId) out.set(r.decisionId, input);
    });
  }
  return out;
}

/**
 * Ledger rows in the window where a model was asked (the ones capture can have
 * stored), newest first. A listed id may still have no copy (sampled out,
 * capped, sensitive, written before capture shipped): `loadDecisionReplay`
 * drops those.
 */
export async function listReplayableDecisions(
  opts: { teamId: string; capability?: string; since: Date; limit: number },
  deps: ReplayReadDeps = {},
): Promise<Array<{ decisionId: string; capability: string; createdAt: Date }>> {
  const limit = Math.max(1, Math.min(MAX_REPLAY_LIST, Math.floor(opts.limit)));
  const rows = await (deps.listLedger ?? dbListLedger)({ ...opts, limit });
  return rows
    .filter(r => r.teamId === opts.teamId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
    .map(r => ({ decisionId: r.decisionId, capability: r.capability, createdAt: r.createdAt }));
}

/** Orchestration fallbacks decided before any state existed: nothing was captured for them. */
export const ORCHESTRATION_PRE_STATE_REASONS = [
  'invalid', 'capability_disabled', 'missing_key', 'retrieval_error', 'no_candidates', 'rule_decided',
] as const;

async function dbLookupLedger(ids: string[]): Promise<ReplayLedgerRow[]> {
  const { db } = await import('./db/client');
  const { decisionRecords, orchestrationDecisions } = await import('./db/schema');
  const { inArray } = await import('drizzle-orm');
  const [a, b] = await Promise.all([
    db.select({ decisionId: decisionRecords.id, teamId: decisionRecords.teamId, workspaceId: decisionRecords.workspaceId, capability: decisionRecords.capability, createdAt: decisionRecords.createdAt })
      .from(decisionRecords).where(inArray(decisionRecords.id, ids)),
    db.select({ decisionId: orchestrationDecisions.id, teamId: orchestrationDecisions.teamId, workspaceId: orchestrationDecisions.workspaceId, capability: orchestrationDecisions.capability, createdAt: orchestrationDecisions.createdAt })
      .from(orchestrationDecisions).where(inArray(orchestrationDecisions.id, ids)),
  ]);
  return [...a, ...b] as ReplayLedgerRow[];
}

/** The predicates, exported so a test can render them with the real dialect. */
export async function replayListPredicates(opts: { teamId: string; capability?: string; since: Date }) {
  const { decisionRecords, orchestrationDecisions } = await import('./db/schema');
  const { and, eq, gte, isNotNull, notInArray, or, isNull } = await import('drizzle-orm');
  const records = and(
    eq(decisionRecords.teamId, opts.teamId),
    gte(decisionRecords.createdAt, opts.since),
    opts.capability ? eq(decisionRecords.capability, opts.capability) : undefined,
    // A model was asked: it answered, or the provider failed it.
    or(isNotNull(decisionRecords.verdict), eq(decisionRecords.failureClass, 'provider')),
  );
  const orchestration = and(
    eq(orchestrationDecisions.teamId, opts.teamId),
    gte(orchestrationDecisions.createdAt, opts.since),
    opts.capability ? eq(orchestrationDecisions.capability, opts.capability) : undefined,
    or(isNull(orchestrationDecisions.reason), notInArray(orchestrationDecisions.reason, [...ORCHESTRATION_PRE_STATE_REASONS])),
  );
  return { records, orchestration };
}

async function dbListLedger(opts: { teamId: string; capability?: string; since: Date; limit: number }): Promise<ReplayLedgerRow[]> {
  const { db } = await import('./db/client');
  const { decisionRecords, orchestrationDecisions } = await import('./db/schema');
  const { desc } = await import('drizzle-orm');
  const where = await replayListPredicates(opts);
  const [a, b] = await Promise.all([
    db.select({ decisionId: decisionRecords.id, teamId: decisionRecords.teamId, workspaceId: decisionRecords.workspaceId, capability: decisionRecords.capability, createdAt: decisionRecords.createdAt })
      .from(decisionRecords).where(where.records).orderBy(desc(decisionRecords.createdAt)).limit(opts.limit),
    db.select({ decisionId: orchestrationDecisions.id, teamId: orchestrationDecisions.teamId, workspaceId: orchestrationDecisions.workspaceId, capability: orchestrationDecisions.capability, createdAt: orchestrationDecisions.createdAt })
      .from(orchestrationDecisions).where(where.orchestration).orderBy(desc(orchestrationDecisions.createdAt)).limit(opts.limit),
  ]);
  return [...a, ...b] as ReplayLedgerRow[];
}
