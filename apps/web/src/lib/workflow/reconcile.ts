/**
 * The reconciliation floor's reads (docs/specs/workflow-state-kernel.md §11).
 * Webhooks are lost, reordered and never redelivered; the floor re-reads each
 * open kernel delivery's PR and imports what GitHub says as a fact, so a
 * single missed `synchronize` or `closed` cannot strand a delivery on a stale
 * head. The floor itself (seam.ts `reconcileKernelDeliveries`) only imports
 * facts and re-enqueues owed effects; the reducer decides what they mean.
 */
import { sql, type SQL } from 'drizzle-orm';
import { TERMINAL_STATES, type KernelView } from './types';

/**
 * A REPAIRING delivery bound to a queued mechanical row whose pinned head the
 * delivery has already moved off (75c04d5d). The pinned write can never land
 * and no worker ends a mechanical row, while a re-read of the held head is a
 * duplicate: the floor ends the row (RepairNotNeeded) instead. Returns its id.
 */
export function strandedMechanicalRepair(view: KernelView): string | null {
  const d = view.delivery;
  if (!d || d.state !== 'REPAIRING' || !d.boundAttemptId || !d.currentHeadSha) return null;
  const a = view.attempts.find((x) => x.id === d.boundAttemptId);
  if (!a || a.mode !== 'mechanical' || a.status !== 'queued' || !a.boundHeadSha) return null;
  return a.boundHeadSha !== d.currentHeadSha ? a.id : null;
}

export interface FloorCandidate {
  id: string;
  workspace_id: string;
  repo_full_name: string;
  pr_number: number;
  state: string;
  current_head_sha: string | null;
}

/**
 * Kernel deliveries with a bound PR for the floor to re-read, skipping any that moved in the last
 * `minQuietMs` so the floor never races a webhook still being handled. `only` narrows the pass to
 * named deliveries (the fast heal, kernel-heal.ts).
 *
 * S4a order, so a lost merge is never starved: first a delivery holding a merge or close fact
 * the reducer never applied (a webhook whose live read failed, a render's observation), which is
 * exempt from the quiet window; then the one the floor checked longest ago (`floor_checked_at`,
 * stamped by `floorCheckedSql` after each pass, so the queue rotates instead of re-reading the
 * same stale rows every hour); then the stalest. A delivery released to legacy is legacy's and
 * takes no slot.
 */
export function floorCandidatesSql(o: { limit: number; minQuietMs: number; only?: string[] | null }): SQL {
  const terminal = JSON.stringify([...TERMINAL_STATES]);
  const unapplied = sql`(SELECT EXISTS (SELECT 1 FROM workflow_facts f
      WHERE f.workspace_id = d.workspace_id AND f.repo_full_name = d.repo_full_name AND f.pr_number = d.pr_number
        AND f.kind = 'pr_closed' AND f.applied_transition_id IS NULL
        -- News the delivery has not moved on since, from the last day: an old or already-answered
        -- fact (a close the delivery holds under another key) must not hold a slot forever.
        AND f.observed_at > COALESCE(d.last_transition_at, d.created_at)
        AND f.observed_at > now() - interval '1 day'))`;
  return sql`-- workflow:floor_candidates
SELECT d.id, d.workspace_id, d.repo_full_name, d.pr_number, d.state, d.current_head_sha, ${unapplied} AS unapplied_terminal
FROM workflow_deliveries d
WHERE d.pr_number IS NOT NULL AND d.repo_full_name IS NOT NULL AND d.authority = 'kernel'
  AND d.state NOT IN (SELECT jsonb_array_elements_text(${terminal}::jsonb))
  AND (COALESCE(d.last_transition_at, d.updated_at) <= now() - make_interval(secs => ${o.minQuietMs}::bigint / 1000.0) OR ${unapplied})
  ${o.only ? sql`AND d.id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(o.only)}::jsonb))::uuid)` : sql``}
ORDER BY unapplied_terminal DESC, d.floor_checked_at ASC NULLS FIRST, COALESCE(d.last_transition_at, d.updated_at) ASC, d.id
LIMIT ${o.limit}::int`;
}

/** Bookkeeping after a floor pass: these deliveries were read now (not a transition, not delivery state). */
export function floorCheckedSql(ids: string[]): SQL {
  return sql`-- workflow:floor_checked
UPDATE workflow_deliveries SET floor_checked_at = now()
WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid)`;
}

export interface TreadmillCycleCandidate {
  id: string;
  version: number | string;
  workspace_id: string;
  repo_full_name: string;
  pr_number: number | string;
}

/**
 * S15 cycles: kernel deliveries whose CURRENT state is the behind-refresh
 * treadmill's escalation (the transition that produced `d.version` carries the
 * `:treadmill` key), made at least `cooldownMs` ago. Any later move (a person's
 * override, a merge refusal, a new head) is a newer version and drops it. The
 * caller pins `expectedVersion` to `version`, so a move between this read and
 * the restart is refused too.
 */
export function treadmillCycleCandidatesSql(o: { limit: number; cooldownMs: number }): SQL {
  return sql`-- workflow:treadmill_cycle_candidates
SELECT d.id, d.version, d.workspace_id, d.repo_full_name, d.pr_number FROM workflow_deliveries d
JOIN workflow_transitions t ON t.delivery_id = d.id AND t.to_version = d.version
WHERE d.authority = 'kernel' AND d.state = 'ESCALATED' AND d.state_reason = 'landing_needs_human'
  AND d.pr_number IS NOT NULL
  AND t.idempotency_key LIKE '%:treadmill'
  AND t.created_at <= now() - make_interval(secs => ${o.cooldownMs}::bigint / 1000.0)
ORDER BY t.created_at ASC, d.id
LIMIT ${o.limit}::int`;
}
