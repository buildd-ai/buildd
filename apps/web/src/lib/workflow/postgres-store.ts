/**
 * buildd's Postgres adapter for the kernel's Store port
 * (docs/specs/workflow-kernel-library.md §2). Each method runs one of the
 * statements the kernel has always run, built where they have always been
 * built (kernel.ts, effects.ts, landing-lane.ts, facts.ts, authority.ts), and
 * maps its rows to the port's records. No statement changes here: the package
 * owns the logic that sequences them (`applyCommandOn`, `drainEffects`,
 * `acquireLaneOn` / `settleLanesOn`, `decideAndRecord`), this file owns the SQL.
 *
 * The same conformance scenarios the package runs on its in-memory store run
 * against this adapter under `bun run test:db`
 * (apps/web/tests/db/workflow-kernel-conformance.test.ts, AC-7).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { ClaimedEffect, EffectSnapshot, Store, StoredFact } from '@buildd/workflow-kernel/ports';
import type { EffectKind } from './commands';
import type { DeliveryState } from './types';
import {
  findTransitionSql, loadViewSql, recordOnlySql, toAttemptSnapshot, toDeliverySnapshot, toRoundSnapshot, transitionSql, type Exec,
} from './kernel';
import {
  ackEffectSql, claimDueEffectsSql, failEffectSql, insertFollowupEffectSql, parkEffectSql, renewEffectLeaseSql,
} from './effects';
import { releaseSql } from './authority';
import { acquireLaneSql, laneHolderSql, releaseSettledLanesSql, wakeNextWaiterSql } from './landing-lane';
import { insertFactSql } from './facts';

type Row = Record<string, unknown>;

async function rows(exec: Exec, q: SQL): Promise<Row[]> {
  return ((await exec(q)).rows ?? []) as Row[];
}

/** A unique index aborted the statement (a replayed key, a racing single-flight insert): nothing was written. */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: string }).code;
    if (code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return /duplicate key value violates unique constraint/.test(String((err as Error)?.message ?? ''));
}

function toSnapshot(r: Row): EffectSnapshot {
  const d = r.delivery as { state?: string; version?: number | string } | null;
  const t = r.transition as { to_state?: string; to_version?: number | string } | null;
  return {
    delivery: d && d.state ? { state: d.state as DeliveryState, version: Number(d.version) } : null,
    transition: t && t.to_state ? { toState: t.to_state as DeliveryState, toVersion: Number(t.to_version) } : null,
    authority: r.authority === 'legacy' || r.authority === 'switched_off' ? r.authority : 'kernel',
  };
}

export function toClaimedEffect(r: Row): ClaimedEffect {
  return {
    id: String(r.id),
    deliveryId: String(r.delivery_id),
    transitionId: String(r.transition_id),
    kind: r.kind as EffectKind,
    dedupeKey: String(r.dedupe_key),
    payload: (r.payload as Record<string, unknown>) ?? {},
    attemptCount: Number(r.attempt_count ?? 0),
    ...toSnapshot(r),
  };
}

/** A fact with its payload: what a decision replay reads. A read only; `findFactSql` stays the funnel's. */
export function findFactRecordSql(workspaceId: string, factKey: string): SQL {
  return sql`-- workflow:find_fact_record
SELECT id, applied_transition_id, payload FROM workflow_facts
WHERE workspace_id = ${workspaceId}::uuid AND fact_key = ${factKey}::text
LIMIT 1`;
}

/** Bind a ledger row to the task filed for it; a row already bound keeps its task. */
export function linkAttemptTaskSql(attemptId: string, taskId: string): SQL {
  return sql`-- workflow:link_attempt_task
UPDATE workflow_attempts SET task_id = ${taskId}::uuid, updated_at = now()
WHERE id = ${attemptId}::uuid AND task_id IS NULL`;
}

export function postgresStore(exec: Exec): Store {
  return {
    async loadView(ref) {
      const row = (await rows(exec, loadViewSql(ref)))[0] as { delivery: Row; rounds: Row[]; attempts: Row[] } | undefined;
      if (!row) return { delivery: null, rounds: [], attempts: [] };
      return {
        delivery: toDeliverySnapshot(row.delivery),
        rounds: (row.rounds ?? []).map(toRoundSnapshot),
        attempts: (row.attempts ?? []).map(toAttemptSnapshot),
      };
    },

    async findTransition(deliveryId, key) {
      const hit = (await rows(exec, findTransitionSql(deliveryId, key)))[0];
      return hit ? { id: String(hit.id) } : null;
    },

    async applyTransition(decision, ref) {
      let row: Row | undefined;
      try {
        row = (await rows(exec, transitionSql(decision, { deliveryId: ref.deliveryId, factId: ref.factId ?? null })))[0];
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        return { status: 'conflict', cause: 'unique' };
      }
      if (!row) return { status: 'conflict', cause: 'guard' };
      return { status: 'applied', transitionId: String(row.transition_id), deliveryId: String(row.delivery_id), version: Number(row.version) };
    },

    async recordOnly(deliveryId, record) {
      const q = recordOnlySql(deliveryId, record);
      if (q) await exec(q);
    },

    async insertFact(f) {
      const r = (await rows(exec, insertFactSql({ ...f, kind: f.kind as Parameters<typeof insertFactSql>[0]['kind'] })))[0];
      return r ? { id: String(r.id) } : null;
    },

    async findFact(workspaceId, factKey): Promise<StoredFact | null> {
      const r = (await rows(exec, findFactRecordSql(workspaceId, factKey)))[0];
      if (!r) return null;
      return { id: String(r.id), appliedTransitionId: r.applied_transition_id == null ? null : String(r.applied_transition_id), payload: (r.payload as Record<string, unknown>) ?? {} };
    },

    async claimDueEffects(o) {
      return (await rows(exec, claimDueEffectsSql(o.limit, o.leaseMs, o.deliveryId ?? null))).map(toClaimedEffect);
    },

    async renewEffectLease(id, attemptCount, leaseMs) {
      const r = (await rows(exec, renewEffectLeaseSql(id, attemptCount, leaseMs)))[0];
      return r ? toSnapshot(r) : null;
    },

    async ackEffect(id, attemptCount, outcome) {
      return (await rows(exec, ackEffectSql(id, attemptCount, outcome))).length > 0;
    },

    async failEffect(id, attemptCount, error) {
      const r = (await rows(exec, failEffectSql(id, error, attemptCount)))[0] as { status?: string } | undefined;
      if (!r) return null;
      return r.status === 'dead' ? 'dead' : 'pending';
    },

    async parkEffect(id, attemptCount, outcome, delayMs) {
      return (await rows(exec, parkEffectSql(id, attemptCount, outcome, delayMs))).length > 0;
    },

    async linkAttemptTask(attemptId, taskId) {
      await exec(linkAttemptTaskSql(attemptId, taskId));
    },

    async insertFollowupEffect(e) {
      return (await rows(exec, insertFollowupEffectSql(e))).length > 0;
    },

    async releaseToLegacy(deliveryId) {
      return (await rows(exec, releaseSql(deliveryId))).length > 0;
    },

    async acquireLane(k) {
      return (await rows(exec, acquireLaneSql(k))).length > 0;
    },

    async laneHolder(k) {
      const h = (await rows(exec, laneHolderSql(k)))[0] as { delivery_id?: string; pr_number?: number | null } | undefined;
      return h?.delivery_id ? { deliveryId: String(h.delivery_id), prNumber: h.pr_number ?? null } : null;
    },

    async releaseSettledLanes(deliveryId) {
      return (await rows(exec, releaseSettledLanesSql(deliveryId))).map((r) => ({ repoFullName: String(r.repo_full_name), baseRef: String(r.base_ref) }));
    },

    async wakeNextLaneWaiter(k) {
      const w = (await rows(exec, wakeNextWaiterSql(k)))[0] as { delivery_id?: string } | undefined;
      return w?.delivery_id ? String(w.delivery_id) : null;
    },
  };
}
