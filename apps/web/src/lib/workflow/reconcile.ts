/**
 * The reconciliation floor's reads (docs/specs/workflow-state-kernel.md §11).
 * Webhooks are lost, reordered and never redelivered; the floor re-reads each
 * open kernel delivery's PR and imports what GitHub says as a fact, so a
 * single missed `synchronize` or `closed` cannot strand a delivery on a stale
 * head. The floor itself (seam.ts `reconcileKernelDeliveries`) only imports
 * facts and re-enqueues owed effects; the reducer decides what they mean.
 */
import { sql, type SQL } from 'drizzle-orm';
import { TERMINAL_STATES } from './types';

export interface FloorCandidate {
  id: string;
  workspace_id: string;
  repo_full_name: string;
  pr_number: number;
  state: string;
  current_head_sha: string | null;
}

/**
 * Non-terminal deliveries with a bound PR, stalest first (the ones a lost
 * webhook is most likely to have left behind), skipping any that moved in the
 * last `minQuietMs` so the floor never races a webhook still being handled.
 * `only` narrows the pass to named deliveries.
 */
export function floorCandidatesSql(o: { limit: number; minQuietMs: number; only?: string[] | null }): SQL {
  const terminal = JSON.stringify([...TERMINAL_STATES]);
  return sql`-- workflow:floor_candidates
SELECT id, workspace_id, repo_full_name, pr_number, state, current_head_sha FROM workflow_deliveries
WHERE pr_number IS NOT NULL AND repo_full_name IS NOT NULL
  AND state NOT IN (SELECT jsonb_array_elements_text(${terminal}::jsonb))
  AND COALESCE(last_transition_at, updated_at) <= now() - make_interval(secs => ${o.minQuietMs}::bigint / 1000.0)
  ${o.only ? sql`AND id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(o.only)}::jsonb))::uuid)` : sql``}
ORDER BY COALESCE(last_transition_at, updated_at) ASC, id
LIMIT ${o.limit}::int`;
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
