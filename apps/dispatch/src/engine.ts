// The ScopeQueue engine: one scope's durable queue, runtime-free.
//
// Everything Cloudflare-specific is injected: `Store` is shaped like a DO's
// `ctx.storage.sql` (+ `transactionSync`), the alarm is a set/clear pair, and
// the clock, adapters and producer client are parameters. Tests run it over
// bun:sqlite; ScopeQueue (scope-queue.ts) is the thin DO shell.
//
// Semantics are the design's "Alarm loop" and "Adapter contract". The engine
// never branches on labels or subject; a skip only comes from the producer's
// resolve/relay answer, from expiresAt, or from a route whose every `first`
// step declined.

import {
  MAX_DELIVERY_ATTEMPTS,
  retryDelayMs,
  type DispatchEnvelope,
  type PublishResult,
  type Receipt,
  type ReceiptEvent,
  type RouteStep,
} from '@buildd/dispatch-contract';
import {
  isTargetType,
  targetTypeFromId,
  type AdapterRegistry,
  type ResolvedDeliver,
  type TargetOptions,
  type TargetType,
} from './adapters/types';
import {
  INTENT_STATES,
  TERMINAL_STATES,
  type IntentDetail,
  type IntentState,
  type IntentSummary,
  type IntentsLookupResponse,
  type ScopeCounts,
  type TargetActivity,
  type TargetRecord,
} from './api-types';
import type { ProducerClient } from './producer';

// ── injected interfaces ───────────────────────────────────────────────────

export type SqlValue = string | number | null | ArrayBuffer;
export type Row = Record<string, SqlValue>;

/** Shaped like DurableObjectStorage['sql']: eager execution, one statement per call. */
export interface Sql {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): Row[] };
}

export interface Store {
  sql: Sql;
  /** Run `fn` atomically (DO: `ctx.storage.transactionSync`). */
  transaction<T>(fn: () => T): T;
}

export interface AlarmControl {
  set(at: number): void | Promise<void>;
  clear(): void | Promise<void>;
}

export type Logger = (line: Record<string, unknown>) => void;

export interface EngineDeps {
  store: Store;
  now: () => number;
  alarm: AlarmControl;
  adapters: AdapterRegistry;
  producer: ProducerClient;
  dryRunTypes: ReadonlySet<TargetType>;
  log?: Logger;
}

// ── tunables ──────────────────────────────────────────────────────────────

/** Due intents taken per alarm run. More due → re-arm immediately. */
export const ALARM_BUDGET = 50;
/** Outbound deliveries in flight per alarm run (under the 6-connection limit). */
export const MAX_CONCURRENT_DELIVERIES = 4;
/** An `attempting` intent whose run died is picked up again after this. */
export const ATTEMPT_LEASE_MS = 120_000;
/** Outermost catch, and the cadence while not configured. */
export const FAILSAFE_REARM_MS = 60_000;
export const RECEIPT_FLUSH_COUNT = 25;
export const RECEIPT_FLUSH_AGE_MS = 10_000;
export const RECEIPT_RETRY_MS = 30_000;
export const RECEIPT_BATCH = 100;
/** Terminal intents (and their attempts) are pruned after this. */
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** A reschedule to the past or the next instant is pushed out this far, so a confused producer cannot spin the alarm. */
export const MIN_RESCHEDULE_MS = 15_000;
const MAX_ERROR_CHARS = 200;

// ── schema ────────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS intents (
     id TEXT PRIMARY KEY,
     envelope TEXT NOT NULL,
     dedupe_key TEXT,
     state TEXT NOT NULL,
     next_due INTEGER,
     not_before INTEGER,
     expires_at INTEGER,
     attempt INTEGER NOT NULL,
     step INTEGER NOT NULL DEFAULT 0,
     merged_into TEXT,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     closed_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS intents_due ON intents (state, next_due)`,
  `CREATE INDEX IF NOT EXISTS intents_dedupe ON intents (dedupe_key, state)`,
  `CREATE INDEX IF NOT EXISTS intents_closed ON intents (closed_at)`,
  `CREATE TABLE IF NOT EXISTS attempts (
     seq INTEGER PRIMARY KEY,
     intent_id TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     target TEXT NOT NULL,
     outcome TEXT NOT NULL,
     detail TEXT,
     started_at INTEGER NOT NULL,
     latency_ms INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS attempts_intent ON attempts (intent_id)`,
  `CREATE TABLE IF NOT EXISTS receipts (
     seq INTEGER PRIMARY KEY,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS targets (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     options TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

interface IntentRow {
  id: string;
  envelope: string;
  dedupe_key: string | null;
  state: IntentState;
  next_due: number | null;
  not_before: number | null;
  expires_at: number | null;
  attempt: number;
  step: number;
  merged_into: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

type StepResult =
  | { kind: 'delivered'; via: string }
  | { kind: 'skipped'; via: string }
  | { kind: 'declined'; why: string }
  | { kind: 'rescheduled'; notBefore: number }
  | { kind: 'error'; why: string };

const iso = (ms: number) => new Date(ms).toISOString();
const parseMs = (v: string | undefined): number | null => (v === undefined ? null : Date.parse(v));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
const minOrNull = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

const TERMINAL_SQL = TERMINAL_STATES.map(s => `'${s}'`).join(',');

async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

export class ScopeEngine {
  private readonly sql: Sql;
  private readonly log: Logger;

  constructor(private readonly deps: EngineDeps) {
    this.sql = deps.store.sql;
    this.log = deps.log ?? (line => console.log(JSON.stringify(line)));
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  // ── small helpers ───────────────────────────────────────────────────────

  private rows<T>(query: string, ...b: SqlValue[]): T[] {
    return this.sql.exec(query, ...b).toArray() as unknown as T[];
  }

  private meta(key: string): string | null {
    return this.rows<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)[0]?.value ?? null;
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.sql.exec('DELETE FROM meta WHERE key = ?', key);
    else this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  private get paused(): boolean {
    return this.meta('paused') === '1';
  }

  private receipt(id: string, attempt: number, event: ReceiptEvent, extra: Partial<Receipt> = {}): void {
    const now = this.deps.now();
    const r: Receipt = { id, attempt, event, ...extra, at: iso(now) };
    this.sql.exec('INSERT INTO receipts (body, created_at) VALUES (?, ?)', JSON.stringify(r), now);
  }

  private intent(id: string): IntentRow | undefined {
    return this.rows<IntentRow>('SELECT * FROM intents WHERE id = ?', id)[0];
  }

  // ── publish ─────────────────────────────────────────────────────────────

  /**
   * Store a batch. Each envelope is written (with any `merged` receipt) in one
   * transaction before this returns, so the ack the ingest Worker sends is
   * durable (the DO output gate holds the response until the write commits).
   * Envelopes must already have passed `envelopeProblem`.
   */
  async publish(scopeKey: string, envelopes: DispatchEnvelope[]): Promise<PublishResult[]> {
    const now = this.deps.now();
    const results = this.deps.store.transaction(() => {
      if (this.meta('scope') === null) this.setMeta('scope', scopeKey);
      return envelopes.map(e => this.publishOne(e, now));
    });
    await this.syncAlarm();
    return results;
  }

  private publishOne(e: DispatchEnvelope, now: number): PublishResult {
    if (this.intent(e.id)) return { id: e.id, status: 'duplicate' };
    const notBefore = parseMs(e.notBefore);
    const expiresAt = parseMs(e.expiresAt);
    const due = notBefore ?? now;

    if (e.dedupeKey) {
      const into = this.rows<IntentRow>(
        `SELECT * FROM intents WHERE dedupe_key = ? AND state = 'queued' ORDER BY created_at, id LIMIT 1`,
        e.dedupeKey,
      )[0];
      if (into) {
        this.mergeInto(into, e, notBefore, expiresAt, now);
        return { id: e.id, status: 'merged', into: into.id };
      }
    }

    this.sql.exec(
      `INSERT INTO intents (id, envelope, dedupe_key, state, next_due, not_before, expires_at, attempt, step, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?)`,
      e.id, JSON.stringify(e), e.dedupeKey ?? null, minOrNull(due, expiresAt), notBefore, expiresAt, e.attempt, now, now,
    );
    return { id: e.id, status: 'accepted' };
  }

  /**
   * Collapse `e` into a queued intent with the same dedupeKey: earliest
   * notBefore wins, causes are appended (deduped), the later expiry wins (no
   * expiry on either side = none). The surviving intent keeps its own route
   * and payload; resolve has the final say at delivery anyway.
   */
  private mergeInto(into: IntentRow, e: DispatchEnvelope, notBefore: number | null, expiresAt: number | null, now: number): void {
    const env = JSON.parse(into.envelope) as DispatchEnvelope;
    if (e.labels) {
      const labels = env.labels ?? { cause: e.labels.cause, causes: [] };
      for (const c of [...e.labels.causes, e.labels.cause]) if (!labels.causes.includes(c)) labels.causes.push(c);
      env.labels = labels;
    }
    const mergedNotBefore = into.not_before === null || notBefore === null ? null : Math.min(into.not_before, notBefore);
    if (mergedNotBefore === null) delete env.notBefore;
    else env.notBefore = iso(mergedNotBefore);
    const mergedExpires = into.expires_at === null || expiresAt === null ? null : Math.max(into.expires_at, expiresAt);
    if (mergedExpires === null) delete env.expiresAt;
    else env.expiresAt = iso(mergedExpires);
    const due = Math.min(into.next_due ?? now, notBefore ?? now);

    this.sql.exec(
      `UPDATE intents SET envelope = ?, next_due = ?, not_before = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(env), minOrNull(due, mergedExpires), mergedNotBefore, mergedExpires, now, into.id,
    );
    this.sql.exec(
      `INSERT INTO intents (id, envelope, dedupe_key, state, next_due, not_before, expires_at, attempt, step, merged_into, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, 'merged', NULL, ?, ?, ?, 0, ?, ?, ?, ?)`,
      e.id, JSON.stringify(e), e.dedupeKey ?? null, notBefore, expiresAt, e.attempt, into.id, now, now, now,
    );
    this.receipt(e.id, e.attempt, 'merged', { into: into.id });
  }

  // ── alarm ───────────────────────────────────────────────────────────────

  /** The DO alarm handler. Never throws: the outermost catch re-arms +60 s. */
  async runAlarm(): Promise<void> {
    const started = this.deps.now();
    try {
      this.prune(started);
      if (!this.deps.producer.configured) {
        this.log({ event: 'dispatch_not_configured', scope: this.meta('scope') });
      } else {
        if (!this.paused) await this.deliverDue();
        await this.flushReceipts();
      }
      await this.syncAlarm();
    } catch (err) {
      this.log({ event: 'dispatch_alarm_error', scope: this.meta('scope'), error: errText(err) });
      await this.deps.alarm.set(this.deps.now() + FAILSAFE_REARM_MS);
    }
  }

  private prune(now: number): void {
    const cutoff = now - RETENTION_MS;
    this.deps.store.transaction(() => {
      this.sql.exec(
        `DELETE FROM attempts WHERE intent_id IN (SELECT id FROM intents WHERE state IN (${TERMINAL_SQL}) AND closed_at < ?)`,
        cutoff,
      );
      this.sql.exec(`DELETE FROM intents WHERE state IN (${TERMINAL_SQL}) AND closed_at < ?`, cutoff);
    });
  }

  private async deliverDue(): Promise<void> {
    const now = this.deps.now();
    const due = this.rows<IntentRow>(
      `SELECT * FROM intents WHERE state IN ('queued', 'attempting') AND next_due <= ? ORDER BY next_due, id LIMIT ?`,
      now, ALARM_BUDGET,
    );
    await pool(due, MAX_CONCURRENT_DELIVERIES, async row => {
      try {
        await this.process(row);
      } catch (err) {
        // A bug for one intent must not stall the scope.
        this.log({ event: 'dispatch_intent_error', id: row.id, scope: this.meta('scope'), error: errText(err) });
        this.sql.exec('UPDATE intents SET next_due = ?, updated_at = ? WHERE id = ?', this.deps.now() + FAILSAFE_REARM_MS, this.deps.now(), row.id);
      }
    });
  }

  private async process(row: IntentRow): Promise<void> {
    const start = this.deps.now();
    const scope = this.meta('scope');
    const env = JSON.parse(row.envelope) as DispatchEnvelope;
    const latenessMs = start - (row.next_due ?? start);

    if (row.expires_at !== null && row.expires_at <= start) {
      this.deps.store.transaction(() => {
        this.close(row.id, 'expired', start);
        this.receipt(row.id, row.attempt, 'expired', { why: 'expires_at' });
      });
      this.log({ event: 'dispatch_attempt', id: row.id, scope, target: null, outcome: 'expired', latencyMs: 0, latenessMs });
      return;
    }
    if (row.not_before !== null && row.not_before > start) {
      // Never deliver early, whatever next_due says.
      this.sql.exec('UPDATE intents SET next_due = ?, updated_at = ? WHERE id = ?', row.not_before, start, row.id);
      return;
    }

    // Still `attempting` past its lease: the run that took it died mid-delivery
    // (DO evicted or crashed). Its attempt was counted at take time, so a
    // delivery that kills the DO every time still reaches the cap.
    if (row.state === 'attempting') {
      const lost = 'lost_in_flight';
      if (row.attempt >= MAX_DELIVERY_ATTEMPTS) {
        this.deps.store.transaction(() => {
          this.close(row.id, 'failed', start, row.attempt, lost);
          this.receipt(row.id, row.attempt, 'failed', { why: lost });
        });
        this.log({ event: 'dispatch_attempt', id: row.id, scope, target: null, outcome: 'failed', latencyMs: 0, latenessMs });
        return;
      }
      this.receipt(row.id, row.attempt, 'attempted', { why: lost });
    }

    // Count the attempt when it is taken, in the same write that marks it
    // `attempting` (the in-app claim does attempt_count + 1 likewise). The
    // outcome write below sets the same value, so nothing is counted twice;
    // only a reschedule refunds it.
    const attempt = row.attempt + 1;
    this.sql.exec(
      `UPDATE intents SET state = 'attempting', attempt = ?, next_due = ?, updated_at = ? WHERE id = ?`,
      attempt, start + ATTEMPT_LEASE_MS, start, row.id,
    );

    const firstSteps = env.target.steps.filter(s => s.mode === 'first');
    const declines: string[] = [];
    let terminal: StepResult | null = null;
    let at = row.step;
    for (; at < firstSteps.length; at++) {
      const r = await this.runStep(row.id, env, firstSteps[at]!, attempt, scope, latenessMs);
      if (r.kind === 'declined') {
        declines.push(`${firstSteps[at]!.target}:${r.why}`);
        continue;
      }
      terminal = r;
      break;
    }

    const now = this.deps.now();
    this.deps.store.transaction(() => {
      if (terminal === null) {
        // Every `first` step declined: nothing will change by retrying a
        // policy answer, so the intent closes, like today's terminal
        // broadcast. Projected as delivered `skipped:all_declined`.
        this.close(row.id, 'skipped', now, attempt);
        this.receipt(row.id, attempt, 'delivered', { via: 'skipped:all_declined', why: declines.join(',').slice(0, MAX_ERROR_CHARS) });
        return;
      }
      switch (terminal.kind) {
        case 'delivered':
          this.close(row.id, 'delivered', now, attempt);
          this.receipt(row.id, attempt, 'delivered', { via: terminal.via });
          return;
        case 'skipped':
          this.close(row.id, 'skipped', now, attempt);
          this.receipt(row.id, attempt, 'delivered', { via: terminal.via });
          return;
        case 'rescheduled': {
          // No attempt counted: refund the take-time increment, and resume
          // at the step that asked.
          const nb = Math.max(terminal.notBefore, now + MIN_RESCHEDULE_MS);
          this.sql.exec(
            `UPDATE intents SET state = 'queued', attempt = ?, not_before = ?, next_due = ?, step = ?, updated_at = ? WHERE id = ?`,
            row.attempt, nb, minOrNull(nb, row.expires_at), at, now, row.id,
          );
          return;
        }
        case 'error': {
          if (attempt >= MAX_DELIVERY_ATTEMPTS) {
            this.close(row.id, 'failed', now, attempt, terminal.why);
            this.receipt(row.id, attempt, 'failed', { why: terminal.why });
          } else {
            this.sql.exec(
              `UPDATE intents SET state = 'queued', attempt = ?, step = ?, next_due = ?, last_error = ?, updated_at = ? WHERE id = ?`,
              attempt, at, minOrNull(now + retryDelayMs(attempt), row.expires_at), terminal.why, now, row.id,
            );
            this.receipt(row.id, attempt, 'attempted', { why: terminal.why });
          }
          return;
        }
        default:
          return;
      }
    });

    // Side deliveries: first attempt only, fire-and-forget (the outcome never
    // changes the intent's state). A rescheduled run has not made an attempt.
    if (attempt === 1 && terminal?.kind !== 'rescheduled') {
      for (const step of env.target.steps.filter(s => s.mode === 'also')) {
        await this.runStep(row.id, env, step, attempt, scope, latenessMs);
      }
    }
  }

  private close(id: string, state: IntentState, now: number, attempt?: number, lastError?: string): void {
    this.sql.exec(
      `UPDATE intents SET state = ?, next_due = NULL, attempt = COALESCE(?, attempt), last_error = COALESCE(?, last_error), updated_at = ?, closed_at = ? WHERE id = ?`,
      state, attempt ?? null, lastError ?? null, now, now, id,
    );
  }

  private targetFor(target: string): { type: TargetType | null; options: TargetOptions } {
    const reg = this.rows<{ type: string; options: string }>('SELECT type, options FROM targets WHERE id = ?', target)[0];
    if (reg && isTargetType(reg.type)) return { type: reg.type, options: JSON.parse(reg.options) as TargetOptions };
    return { type: targetTypeFromId(target), options: {} };
  }

  /**
   * One step of one attempt: resolve if needed, then deliver (or record the
   * dry-run decision). Records an attempts row and one log line. A grant from
   * resolve stays in this frame: it is passed to the adapter and dropped.
   */
  private async runStep(id: string, env: DispatchEnvelope, step: RouteStep, attempt: number, scope: string | null, latenessMs: number): Promise<StepResult> {
    const started = this.deps.now();
    let result: StepResult;
    let detail: string;
    try {
      ({ result, detail } = await this.attemptStep(id, env, step, attempt));
    } catch (err) {
      result = { kind: 'error', why: errText(err) };
      detail = result.why;
    }
    const latencyMs = this.deps.now() - started;
    const outcome = result.kind;
    this.sql.exec(
      'INSERT INTO attempts (intent_id, attempt, target, outcome, detail, started_at, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, attempt, step.target, outcome, detail, started, latencyMs,
    );
    this.log({ event: 'dispatch_attempt', id, scope, target: step.target, outcome, latencyMs, latenessMs });
    return result;
  }

  private async attemptStep(id: string, env: DispatchEnvelope, step: RouteStep, attempt: number): Promise<{ result: StepResult; detail: string }> {
    const { type, options } = this.targetFor(step.target);
    const adapter = type ? this.deps.adapters[type] : undefined;
    if (!type || !adapter) return { result: { kind: 'declined', why: 'unknown_target' }, detail: 'unknown_target' };
    const dry = this.deps.dryRunTypes.has(type);

    let resolved: ResolvedDeliver | undefined;
    if (step.resolve || adapter.needsResolve) {
      const answer = await this.deps.producer.resolve({ id, attempt, target: step.target });
      switch (answer.decision) {
        case 'decline':
          return { result: { kind: 'declined', why: answer.why }, detail: dry ? `dry-run:${type}:decline:${answer.why}` : answer.why };
        case 'skip': {
          const via = dry ? `dry-run:${type}:skip` : `skipped:${answer.why}`;
          return { result: { kind: 'skipped', via }, detail: via };
        }
        case 'reschedule':
          return { result: { kind: 'rescheduled', notBefore: Date.parse(answer.notBefore) }, detail: `reschedule:${answer.notBefore}` };
        case 'deliver':
          resolved = answer;
          break;
      }
    }

    if (dry) {
      const via = `dry-run:${type}:deliver`;
      return { result: { kind: 'delivered', via }, detail: via };
    }

    const out = await adapter.deliver({ id, attempt, target: step.target, envelope: env, options }, step, resolved);
    if (out.kind === 'delivered') return { result: out, detail: out.via };
    if (out.kind === 'declined') return { result: out, detail: out.why };
    const via = `skipped:${out.why}`;
    return { result: { kind: 'skipped', via }, detail: via };
  }

  // ── receipts ────────────────────────────────────────────────────────────

  private receiptStats(): { count: number; oldest: number | null } {
    const r = this.rows<{ n: number; oldest: number | null }>('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM receipts')[0];
    return { count: r?.n ?? 0, oldest: r?.oldest ?? null };
  }

  /** Flush when ≥25 are queued or the oldest is ≥10 s old. Rows go only after a 2xx. */
  async flushReceipts(): Promise<void> {
    const now = this.deps.now();
    const { count, oldest } = this.receiptStats();
    if (count === 0 || oldest === null) return;
    const retryAt = Number(this.meta('receipts_retry_at') ?? 0);
    if (now < retryAt) return;
    if (count < RECEIPT_FLUSH_COUNT && now - oldest < RECEIPT_FLUSH_AGE_MS) return;

    for (;;) {
      const batch = this.rows<{ seq: number; body: string }>('SELECT seq, body FROM receipts ORDER BY seq LIMIT ?', RECEIPT_BATCH);
      if (batch.length === 0) break;
      const ok = await this.deps.producer.sendReceipts(batch.map(r => JSON.parse(r.body) as Receipt));
      if (!ok) {
        this.setMeta('receipts_retry_at', String(this.deps.now() + RECEIPT_RETRY_MS));
        this.log({ event: 'dispatch_receipts_flush_failed', scope: this.meta('scope'), pending: count });
        return;
      }
      const seqs = batch.map(r => r.seq);
      this.sql.exec(`DELETE FROM receipts WHERE seq IN (${seqs.map(() => '?').join(',')})`, ...seqs);
      if (batch.length < RECEIPT_BATCH) break;
    }
    this.setMeta('receipts_retry_at', null);
  }

  // ── alarm arming ────────────────────────────────────────────────────────

  /** When the alarm should next fire, or null for "nothing to do". */
  nextAlarmAt(): number | null {
    const now = this.deps.now();
    let at: number | null = null;
    if (!this.paused) {
      const r = this.rows<{ due: number | null }>(`SELECT MIN(next_due) AS due FROM intents WHERE state IN ('queued', 'attempting')`)[0];
      at = minOrNull(at, r?.due ?? null);
    }
    const { count, oldest } = this.receiptStats();
    if (count > 0 && oldest !== null) {
      const deadline = count >= RECEIPT_FLUSH_COUNT ? now : oldest + RECEIPT_FLUSH_AGE_MS;
      at = minOrNull(at, Math.max(deadline, Number(this.meta('receipts_retry_at') ?? 0)));
    }
    if (at !== null && !this.deps.producer.configured) at = Math.max(at, now + FAILSAFE_REARM_MS);
    return at;
  }

  async syncAlarm(): Promise<void> {
    const at = this.nextAlarmAt();
    if (at === null) await this.deps.alarm.clear();
    else await this.deps.alarm.set(Math.max(at, this.deps.now()));
  }

  // ── inspection and control ──────────────────────────────────────────────

  /**
   * Which ids this scope knows. A terminal intent also says what its terminal
   * receipt said (`via` for delivered/skipped, `why` for failed/expired) and
   * when it closed, so the producer's repair floor can project a receipt it
   * lost without asking twice.
   */
  lookup(ids: string[]): IntentsLookupResponse {
    const marks = ids.map(() => '?').join(',');
    const known = ids.length === 0 ? [] : this.rows<IntentRow>(
      `SELECT id, envelope, state, attempt, merged_into, last_error, closed_at FROM intents WHERE id IN (${marks})`,
      ...ids,
    );
    const closedIds = known.filter(r => r.state === 'delivered' || r.state === 'skipped').map(r => r.id);
    const outcomes = closedIds.length === 0 ? [] : this.rows<{ intent_id: string; attempt: number; target: string; outcome: string; detail: string | null }>(
      `SELECT intent_id, attempt, target, outcome, detail FROM attempts
       WHERE intent_id IN (${closedIds.map(() => '?').join(',')}) AND outcome IN ('delivered', 'skipped') ORDER BY seq`,
      ...closedIds,
    );
    const byId = new Map(known.map(r => [r.id, r]));
    return {
      known: ids.filter(id => byId.has(id)).map(id => {
        const r = byId.get(id)!;
        const s: IntentSummary = { id, state: r.state, attempt: r.attempt, ...(r.merged_into ? { mergedInto: r.merged_into } : {}) };
        if (!(TERMINAL_STATES as readonly string[]).includes(r.state)) return s;
        if (r.closed_at !== null) s.closedAt = iso(r.closed_at);
        if (r.state === 'delivered' || r.state === 'skipped') {
          s.via = this.closingVia(r, outcomes.filter(o => o.intent_id === id));
        } else if (r.state === 'failed' && r.last_error) {
          s.why = r.last_error;
        } else if (r.state === 'expired') {
          s.why = 'expires_at';
        }
        return s;
      }),
      unknown: ids.filter(id => !byId.has(id)),
    };
  }

  /**
   * The `via` of a delivered/skipped intent's terminal receipt: the first
   * `first`-mode step of the closing attempt that delivered or skipped (an
   * `also` step runs after it and never changes the state). None means every
   * `first` step declined, which closes as `skipped:all_declined`.
   */
  private closingVia(r: IntentRow, outcomes: { attempt: number; target: string; outcome: string; detail: string | null }[]): string {
    const firstTargets = new Set((JSON.parse(r.envelope) as DispatchEnvelope).target.steps.filter(s => s.mode === 'first').map(s => s.target));
    const closing = outcomes.find(o => o.attempt === r.attempt && firstTargets.has(o.target));
    if (closing?.detail) return closing.detail;
    return r.state === 'skipped' ? 'skipped:all_declined' : 'dispatch';
  }

  detail(id: string): IntentDetail | null {
    const r = this.intent(id);
    if (!r) return null;
    const env = JSON.parse(r.envelope) as DispatchEnvelope;
    const attempts = this.rows<{ target: string; outcome: string; detail: string | null; started_at: number }>(
      'SELECT target, outcome, detail, started_at FROM attempts WHERE intent_id = ? ORDER BY seq', id,
    );
    const targets = new Map<string, TargetActivity>();
    for (const a of attempts) {
      const t = targets.get(a.target) ?? { target: a.target, attempts: 0, lastOutcome: a.outcome, lastAt: iso(a.started_at) };
      t.attempts++;
      t.lastOutcome = a.outcome;
      t.lastAt = iso(a.started_at);
      if (a.detail) t.lastDetail = a.detail;
      else delete t.lastDetail;
      targets.set(a.target, t);
    }
    return {
      id: r.id,
      state: r.state,
      attempt: r.attempt,
      ...(r.merged_into ? { mergedInto: r.merged_into } : {}),
      kind: env.kind,
      ...(env.source.subject ? { subject: env.source.subject } : {}),
      ...(env.dedupeKey ? { dedupeKey: env.dedupeKey } : {}),
      ...(env.labels ? { labels: env.labels } : {}),
      steps: env.target.steps,
      step: r.step,
      ...(r.not_before !== null ? { notBefore: iso(r.not_before) } : {}),
      ...(r.expires_at !== null ? { expiresAt: iso(r.expires_at) } : {}),
      ...(r.next_due !== null ? { nextDue: iso(r.next_due) } : {}),
      ...(r.last_error ? { lastError: r.last_error } : {}),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      ...(r.closed_at !== null ? { closedAt: iso(r.closed_at) } : {}),
      targets: [...targets.values()],
    };
  }

  counts(): ScopeCounts {
    const intents = Object.fromEntries(INTENT_STATES.map(s => [s, 0])) as Record<IntentState, number>;
    for (const r of this.rows<{ state: IntentState; n: number }>('SELECT state, COUNT(*) AS n FROM intents GROUP BY state')) intents[r.state] = r.n;
    const due = this.rows<{ due: number | null }>(`SELECT MIN(next_due) AS due FROM intents WHERE state IN ('queued', 'attempting')`)[0]?.due ?? null;
    const targets = this.rows<{ n: number }>('SELECT COUNT(*) AS n FROM targets')[0]?.n ?? 0;
    return {
      scope: this.meta('scope'),
      paused: this.paused,
      intents,
      pendingReceipts: this.receiptStats().count,
      ...(due !== null ? { nextDue: iso(due) } : {}),
      targets,
    };
  }

  async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    this.setMeta('paused', paused ? '1' : null);
    await this.syncAlarm();
    return { paused };
  }

  putTarget(id: string, type: TargetType, options: TargetOptions): TargetRecord {
    this.sql.exec(
      `INSERT INTO targets (id, type, options, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET type = excluded.type, options = excluded.options, updated_at = excluded.updated_at`,
      id, type, JSON.stringify(options), this.deps.now(),
    );
    return { id, type, options };
  }
}
