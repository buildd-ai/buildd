/**
 * Loads DeliveryViews for the surfaces that show work in flight (Home, the
 * task page, mission views). One statement per call, batched by task id.
 *
 * Only kernel-owned deliveries are returned (§14 cutover): a task whose
 * delivery is legacy-owned, or that has none, is absent from the map and its
 * surface keeps today's projection. A caller therefore never has to know the
 * kill switch exists.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { classifyConflictFix } from '@/lib/conflict-fix-liveness';
import { toAttemptSnapshot, toDeliverySnapshot, toRoundSnapshot, type Exec } from './kernel';
import { attemptFailureCounts, deriveDeliveryView, type AttemptTaskRef, type DeliveryView, type RemediationRef, type TransitionRef } from './projections';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

type J = Record<string, unknown>;

export function deliveryViewsSql(taskIds: string[]): SQL {
  return sql`-- workflow:delivery_views
WITH ids AS (SELECT DISTINCT x::uuid AS id FROM jsonb_array_elements_text(${JSON.stringify(taskIds)}::jsonb) x),
dl AS (
  SELECT d.* FROM workflow_deliveries d
  WHERE d.authority = 'kernel'
    AND (d.owner_task_id IN (SELECT id FROM ids)
      OR d.id IN (SELECT t.delivery_id FROM tasks t WHERE t.id IN (SELECT id FROM ids) AND t.delivery_id IS NOT NULL))
)
SELECT to_jsonb(d.*) AS delivery,
  COALESCE((SELECT jsonb_agg(to_jsonb(r.*) ORDER BY r.round) FROM workflow_review_rounds r WHERE r.delivery_id = d.id), '[]'::jsonb) AS rounds,
  COALESCE((SELECT jsonb_agg(to_jsonb(a.*) ORDER BY a.family, a.mode, a.attempt_no) FROM workflow_attempts a WHERE a.delivery_id = d.id), '[]'::jsonb) AS attempts,
  (SELECT jsonb_build_object('command', tr.command, 'from_state', tr.from_state, 'to_state', tr.to_state, 'evidence', tr.evidence, 'created_at', tr.created_at)
     FROM workflow_transitions tr WHERE tr.delivery_id = d.id ORDER BY tr.to_version DESC LIMIT 1) AS last_transition,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'role', COALESCE(t.delivery_role, CASE WHEN t.id = d.owner_task_id THEN 'owner' END), 'status', t.status, 'created_at', t.created_at) ORDER BY t.created_at)
     FROM tasks t WHERE t.delivery_id = d.id OR t.id = d.owner_task_id), '[]'::jsonb) AS attempt_tasks,
  (SELECT jsonb_build_object('id', t.id, 'status', t.status, 'created_at', t.created_at, 'claimed_at', t.claimed_at,
            'worker_status', w.status, 'worker_updated_at', w.updated_at, 'recovered_at', t.context->'conflictRecovery'->>'at')
     FROM tasks t
     LEFT JOIN LATERAL (SELECT ww.status, ww.updated_at FROM workers ww WHERE ww.task_id = t.id ORDER BY ww.created_at DESC LIMIT 1) w ON true
     WHERE t.workspace_id = d.workspace_id AND d.pr_number IS NOT NULL AND t.conflict_retry_pr_number = d.pr_number
       AND t.status IN ('pending', 'assigned', 'in_progress')
     ORDER BY t.created_at DESC LIMIT 1) AS remediation
FROM dl d`;
}

const iso = (v: unknown): string => (v == null ? '' : new Date(String(v)).toISOString());

/** Pure: an open conflict-fix row as a RemediationRef, with the same stall rule recovery uses (S37). */
export function remediationFrom(r: J | null | undefined, now: number): RemediationRef | null {
  if (!r || !r.id) return null;
  const v = classifyConflictFix({
    status: String(r.status),
    createdAt: r.created_at == null ? null : String(r.created_at),
    claimedAt: r.claimed_at == null ? null : String(r.claimed_at),
    workerStatus: r.worker_status == null ? null : String(r.worker_status),
    workerUpdatedAt: r.worker_updated_at == null ? null : String(r.worker_updated_at),
    lastRecoveryAt: r.recovered_at == null ? null : String(r.recovered_at),
  }, now);
  return { taskId: String(r.id), family: 'conflict', taskStatus: String(r.status), stalled: v.stalled, stallReason: v.reason };
}

export function rowToDeliveryView(row: J, now = Date.now()): DeliveryView | null {
  if (!row.delivery) return null;
  const rounds = ((row.rounds as J[]) ?? []).map(toRoundSnapshot);
  const attempts = ((row.attempts as J[]) ?? []).map(toAttemptSnapshot);
  const lt = row.last_transition as J | null;
  const lastTransition: TransitionRef | null = lt ? {
    command: String(lt.command), fromState: lt.from_state == null ? null : String(lt.from_state), toState: String(lt.to_state),
    evidence: (lt.evidence as Record<string, unknown> | null) ?? null, createdAt: iso(lt.created_at),
  } : null;
  const attemptTasks: AttemptTaskRef[] = ((row.attempt_tasks as J[]) ?? []).map((t) => ({
    taskId: String(t.id), role: t.role == null ? 'attempt' : String(t.role), status: String(t.status), createdAt: iso(t.created_at),
  }));
  return deriveDeliveryView({
    view: { delivery: toDeliverySnapshot(row.delivery as J), rounds, attempts },
    lastTransition,
    attemptTasks,
    remediation: remediationFrom(row.remediation as J | null, now),
  });
}

/**
 * taskId → DeliveryView for every given task (owner or attempt) that belongs
 * to a kernel-owned delivery. Never throws: a projection read failing must
 * degrade the surface to its legacy projection, not break the page.
 */
export async function getDeliveryViewsForTasks(taskIds: string[], exec: Exec = dbExec): Promise<Map<string, DeliveryView>> {
  const out = new Map<string, DeliveryView>();
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const res = await exec(deliveryViewsSql(ids));
    const want = new Set(ids);
    for (const row of (res.rows ?? []) as J[]) {
      const v = rowToDeliveryView(row);
      if (!v) continue;
      if (want.has(v.ownerTaskId)) out.set(v.ownerTaskId, v);
      for (const h of v.history) if (want.has(h.taskId)) out.set(h.taskId, v);
    }
  } catch (err) {
    console.warn('[workflow] delivery views unavailable; surfaces fall back to legacy projections:', err instanceof Error ? err.message : err);
  }
  return out;
}

/**
 * S35: failed tasks that are replaced work, by the kernel's reading. A failed
 * attempt (or owner) of a kernel-owned delivery that is still live or already
 * shipped is history, not a failure of the mission; only a delivery that is
 * itself FAILED keeps its current attempt failing. Legacy tasks are absent
 * and keep the existing title/PR supersession rule.
 */
export async function kernelReplacedFailedTaskIds(failedTaskIds: string[], exec: Exec = dbExec): Promise<Set<string>> {
  const views = await getDeliveryViewsForTasks(failedTaskIds, exec);
  const out = new Set<string>();
  for (const id of failedTaskIds) {
    const v = views.get(id);
    if (v && !attemptFailureCounts(v, id)) out.add(id);
  }
  return out;
}
