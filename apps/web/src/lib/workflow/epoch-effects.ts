/**
 * The mission epochs' outbox (docs/specs/workflow-kernel-library.md §6): the
 * refresh a mission's writable epoch owes, as a `workflow_effects` row owned by
 * the epoch (`epoch_id`, no delivery or transition), drained at least once.
 *
 * Owed by `oweMissionRefresh` (a mission task's claim, the hourly backstop),
 * from the package's `owedRefresh`: the writable epoch owes one refresh of its
 * own branch, a merged epoch owes none. Drained by `drainEpochEffects`: the
 * asking request drains what it just owed (bounded by its budget), and the
 * kernel floor drains whatever is still due (a request torn down mid-refresh,
 * a retry after a failure).
 *
 * The drain is the PR deliveries' rules on a different owner: claim with
 * FOR UPDATE SKIP LOCKED under a lease, renew the row's lease fenced to its
 * attempt just before it runs and re-read the epoch then, ack, park or fail
 * with the same backoff (`effectRetry`). An effect whose epoch is no longer
 * the open one on the branch it was owed for (`epochEffectIsCurrent`) is done
 * as `skipped:superseded` without running. Delivery drains never claim these
 * rows (`claimDueEffectsSql` filters `delivery_id IS NOT NULL`).
 *
 * The handler is the host's (the refresh itself lives in
 * lib/mission-branch-refresh.ts); this module never imports it.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import {
  epochEffectIsCurrent, owedRefresh, writableEpoch,
  type EpochEffectKind, type EpochEffectSpec, type EpochSnapshot, type RefreshTrigger,
} from '@buildd/workflow-kernel/delivery-epochs';
import { EFFECT_LEASE_MS, ackEffectSql, failEffectSql, parkEffectSql } from './effects';
import { loadMissionEpochView } from './delivery-epochs';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export type { EpochEffectKind, RefreshTrigger } from '@buildd/workflow-kernel/delivery-epochs';

/** The epoch as the drain re-reads it just before a row runs. */
export type EpochEffectSnapshot = Pick<EpochSnapshot, 'state' | 'branch' | 'missionId'>;

export interface ClaimedEpochEffect {
  id: string;
  epochId: string;
  kind: EpochEffectKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  epoch: EpochEffectSnapshot | null;
}

/** What a handler answers: an outcome to record, or a wait that spends no attempt. Throwing is a failed attempt. */
export type EpochEffectHandler = (e: ClaimedEpochEffect) => Promise<{ outcome: string; park?: { delayMs: number }; value?: unknown }>;
export type EpochEffectHandlers = Partial<Record<EpochEffectKind, EpochEffectHandler>>;

// ── Statements ──────────────────────────────────────────────────────────────

/**
 * Owe one effect on an epoch, only while that epoch is still the open one: an
 * epoch that merged between the read and this statement owes nothing.
 * Idempotent on the dedupe key.
 */
export function oweEpochEffectSql(e: EpochEffectSpec): SQL {
  return sql`-- workflow:owe_epoch_effect
INSERT INTO workflow_effects (epoch_id, kind, dedupe_key, payload)
SELECT ep.id, ${e.kind}::text, ${e.dedupeKey}::text, ${JSON.stringify(e.payload)}::jsonb
FROM workflow_mission_epochs ep
WHERE ep.id = ${e.epochId}::uuid AND ep.state = 'open'
ON CONFLICT (dedupe_key) DO NOTHING
RETURNING id`;
}

/** The row behind a dedupe key: what an ask that found its row already owed waits on. */
export function epochEffectByKeySql(dedupeKey: string): SQL {
  return sql`-- workflow:epoch_effect_by_key
SELECT id, status, outcome FROM workflow_effects WHERE dedupe_key = ${dedupeKey}::text AND epoch_id IS NOT NULL`;
}

function epochSnapshotSql(): SQL {
  return sql`(SELECT jsonb_build_object('state', ep.state, 'branch', ep.branch, 'mission_id', ep.mission_id)
    FROM workflow_mission_epochs ep WHERE ep.id = e.epoch_id) AS epoch`;
}

export function claimDueEpochEffectsSql(limit: number, leaseMs = EFFECT_LEASE_MS, effectIds?: string[] | null): SQL {
  return sql`-- workflow:claim_epoch_effects
WITH due AS (
  SELECT id FROM workflow_effects
  WHERE epoch_id IS NOT NULL
    AND ((status = 'pending' AND not_before <= now())
      OR (status = 'delivering' AND lease_until < now()))
    ${effectIds ? sql`AND id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(effectIds)}::jsonb))::uuid)` : sql``}
  ORDER BY not_before, id
  LIMIT ${limit}::int
  FOR UPDATE SKIP LOCKED
),
claimed AS (
UPDATE workflow_effects e
SET status = 'delivering', attempt_count = e.attempt_count + 1,
    lease_until = now() + make_interval(secs => ${leaseMs}::int / 1000.0), updated_at = now()
FROM due
WHERE e.id = due.id
RETURNING e.id, e.epoch_id, e.kind, e.dedupe_key, e.payload, e.attempt_count, e.not_before
)
SELECT * FROM claimed ORDER BY not_before, id`;
}

/** Renew one claimed row's lease, fenced to its attempt, and read its epoch as it is now. */
export function renewEpochEffectSql(id: string, attemptCount: number, leaseMs = EFFECT_LEASE_MS): SQL {
  return sql`-- workflow:renew_epoch_effect
UPDATE workflow_effects e
SET lease_until = now() + make_interval(secs => ${leaseMs}::int / 1000.0), updated_at = now()
WHERE e.id = ${id}::uuid AND e.status = 'delivering' AND e.attempt_count = ${attemptCount}::int
RETURNING e.id, ${epochSnapshotSql()}`;
}

const rowsOf = async (exec: Exec, q: SQL) => ((await exec(q)).rows ?? []) as Array<Record<string, unknown>>;

function toEpochSnapshot(v: unknown): EpochEffectSnapshot | null {
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
  if (!o) return null;
  return { state: o.state === 'merged' ? 'merged' : 'open', branch: String(o.branch), missionId: String(o.mission_id) };
}

// ── Owing ───────────────────────────────────────────────────────────────────

export type OweRefreshResult =
  /** The mission has no epoch rows (it predates them, not yet adopted): the caller refreshes the legacy way. */
  | { owed: 'legacy' }
  /** No writable epoch to refresh: it merged, the mission closed, or its branch is not cut yet. */
  | { owed: 'none'; reason: 'mission_terminal' | 'epoch_merged' | 'branch_not_cut' }
  /** The effect row (`fresh`: written by this ask; otherwise an ask inside the same window already owed it). */
  | { owed: 'effect'; effectId: string; epochId: string; fresh: boolean };

/** Owe the refresh a mission's writable epoch owes now, if it owes one. */
export async function oweMissionRefresh(
  missionId: string,
  p: { trigger: RefreshTrigger; now?: Date; exec?: Exec },
): Promise<OweRefreshResult> {
  const exec = p.exec ?? dbExec;
  const loaded = await loadMissionEpochView(missionId, { exec, workOf: async () => ({ unfinishedTasks: 0, openTaskPrs: 0 }), legacyPrOf: async () => null });
  if (!loaded || loaded.view.epochs.length === 0) return { owed: 'legacy' };
  const spec = owedRefresh(loaded.view, { trigger: p.trigger, nowMs: (p.now ?? new Date()).getTime() });
  if (!spec) {
    const reason = loaded.view.terminal ? 'mission_terminal' : writableEpoch(loaded.view) ? 'branch_not_cut' : 'epoch_merged';
    return { owed: 'none', reason };
  }
  const [inserted] = await rowsOf(exec, oweEpochEffectSql(spec));
  if (inserted) return { owed: 'effect', effectId: String(inserted.id), epochId: spec.epochId, fresh: true };
  const [existing] = await rowsOf(exec, epochEffectByKeySql(spec.dedupeKey));
  // Neither inserted nor found: the epoch merged between the read and the write.
  return existing ? { owed: 'effect', effectId: String(existing.id), epochId: spec.epochId, fresh: false } : { owed: 'none', reason: 'epoch_merged' };
}

// ── Draining ────────────────────────────────────────────────────────────────

export interface EpochDrainSummary {
  claimed: number;
  done: number;
  skipped: number;
  failed: number;
  lost: number;
  dead: number;
  /** Each row that ran here: its handler's answer, for the asking caller's log. */
  ran: Array<{ effectId: string; epochId: string; missionId: string | null; outcome: string; value?: unknown }>;
}

/** Drain up to `limit` due epoch effects once (or only `effectIds`). Handlers MUST be idempotent. */
export async function drainEpochEffects(o: {
  handlers: EpochEffectHandlers;
  limit?: number;
  effectIds?: string[] | null;
  exec?: Exec;
  leaseMs?: number;
}): Promise<EpochDrainSummary> {
  const exec = o.exec ?? dbExec;
  const leaseMs = o.leaseMs ?? EFFECT_LEASE_MS;
  const summary: EpochDrainSummary = { claimed: 0, done: 0, skipped: 0, failed: 0, lost: 0, dead: 0, ran: [] };
  if (o.effectIds && o.effectIds.length === 0) return summary;
  const rows = await rowsOf(exec, claimDueEpochEffectsSql(o.limit ?? 25, leaseMs, o.effectIds ?? null));
  summary.claimed = rows.length;
  for (const r of rows) {
    const id = String(r.id);
    const attemptCount = Number(r.attempt_count);
    const [renewed] = await rowsOf(exec, renewEpochEffectSql(id, attemptCount, leaseMs));
    if (!renewed) { summary.lost++; continue; }
    const payload = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload ?? {}) as Record<string, unknown>;
    const e: ClaimedEpochEffect = {
      id, epochId: String(r.epoch_id), kind: String(r.kind) as EpochEffectKind, dedupeKey: String(r.dedupe_key),
      payload, attemptCount, epoch: toEpochSnapshot(renewed.epoch),
    };
    const settle = async (q: SQL) => (await rowsOf(exec, q)).length > 0;
    if (!epochEffectIsCurrent(e.epoch, e.payload)) {
      if (await settle(ackEffectSql(id, attemptCount, 'skipped:superseded'))) summary.skipped++; else summary.lost++;
      summary.ran.push({ effectId: id, epochId: e.epochId, missionId: e.epoch?.missionId ?? null, outcome: 'skipped:superseded' });
      continue;
    }
    const handler = o.handlers[e.kind];
    try {
      if (!handler) throw new Error(`no handler for ${e.kind}`);
      const res = await handler(e);
      summary.ran.push({ effectId: id, epochId: e.epochId, missionId: e.epoch?.missionId ?? null, outcome: res.outcome, value: res.value });
      if (res.park) {
        if (await settle(parkEffectSql(id, attemptCount, res.outcome, res.park.delayMs))) summary.skipped++; else summary.lost++;
        continue;
      }
      if (!(await settle(ackEffectSql(id, attemptCount, res.outcome)))) summary.lost++;
      else if (res.outcome.startsWith('skipped')) summary.skipped++; else summary.done++;
    } catch (err) {
      const lastError = String((err as Error)?.message ?? err);
      summary.ran.push({ effectId: id, epochId: e.epochId, missionId: e.epoch?.missionId ?? null, outcome: `error:${lastError.slice(0, 200)}` });
      const [failed] = await rowsOf(exec, failEffectSql(id, lastError, attemptCount));
      if (!failed) summary.lost++;
      else if (failed.status === 'dead') {
        // Not escalated: the next backstop owes a fresh row, and the floor logs the dead one.
        summary.dead++;
        console.error(`[workflow] epoch effect ${id} (${e.kind}) is dead after ${attemptCount} attempts: ${lastError.slice(0, 300)}`);
      } else summary.failed++;
    }
  }
  return summary;
}

/**
 * The floor's pass (kernel-floor.ts): whatever epoch effect is still due, with
 * the handlers the composition root fills in (`MISSION_EPOCH_HOOKS`).
 */
export async function drainDueEpochEffects(o: { limit?: number; exec?: Exec; handlers?: EpochEffectHandlers } = {}): Promise<EpochDrainSummary> {
  const handlers = o.handlers ?? (await import('@/modules')).MISSION_EPOCH_HOOKS.epochEffectHandlers;
  return drainEpochEffects({ handlers, limit: o.limit, exec: o.exec });
}
