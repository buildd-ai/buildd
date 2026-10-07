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
import { ownerDeliveryDisplays, replacedFailedTaskIds, type DeliveryDisplay } from './delivery-display';
import { deriveDeliveryView, type AttemptTaskRef, type DeliveryView, type RemediationRef, type TransitionRef } from './projections';

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
     ORDER BY t.created_at DESC LIMIT 1) AS remediation,
  (SELECT jsonb_build_object('git_config', w.git_config) FROM workspaces w WHERE w.id = d.workspace_id) AS workspace,
  (SELECT jsonb_build_object('requires_review', ot.requires_review, 'landing', ot.context->'landing', 'landing_handoff', ot.context->'landingHandoff',
            'mission', (SELECT jsonb_build_object('merge_policy', m.merge_policy, 'requires_review', m.requires_review,
                          'working_branch', m.working_branch, 'integration_branch_enabled', m.integration_branch_enabled)
                        FROM missions m WHERE m.id = ot.mission_id))
     FROM tasks ot WHERE ot.id = d.owner_task_id) AS owner_task
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

/**
 * The approved-merge slot: does an APPROVED delivery wait on a person to merge
 * it (true: owner `human`, needs you) or does the landing path merge it (false:
 * owner `landing`, merging)? Answered from the loader row (delivery, workspace
 * git config, owner task, mission) by the effective merge policy for that PR.
 * That policy belongs to the reviews module, which core never imports
 * (scripts/module-boundaries.test.ts): the composition root fills the slot
 * (`apps/web/src/modules.ts` `APPROVED_MERGE_RULE`).
 */
export type ApprovedMergeRule = (row: J) => boolean;

/** With no rule a person merges: an unknown policy never hides a merge that waits on you. */
const PERSON_MERGES: ApprovedMergeRule = () => true;

/** The composition root's rule, loaded on first use so this file does not load every module. */
async function approvedMergeRule(): Promise<ApprovedMergeRule> {
  try {
    return (await import('@/modules')).APPROVED_MERGE_RULE;
  } catch (err) {
    console.warn('[workflow] approved-merge rule unavailable; approved PRs read as yours:', err instanceof Error ? err.message : err);
    return PERSON_MERGES;
  }
}

export function rowToDeliveryView(row: J, now = Date.now(), approvedNeedsPerson: ApprovedMergeRule = PERSON_MERGES): DeliveryView | null {
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
    approvedNeedsPerson: (row.delivery as J).state === 'APPROVED' ? approvedNeedsPerson(row) : false,
  });
}

/**
 * taskId → DeliveryView for every given task (owner or attempt) that belongs
 * to a kernel-owned delivery. Never throws: a projection read failing must
 * degrade the surface to its legacy projection, not break the page.
 */
export async function getDeliveryViewsForTasks(taskIds: string[], exec: Exec = dbExec, rule?: ApprovedMergeRule): Promise<Map<string, DeliveryView>> {
  const out = new Map<string, DeliveryView>();
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const res = await exec(deliveryViewsSql(ids));
    const want = new Set(ids);
    const rows = (res.rows ?? []) as J[];
    const needsPerson = rule ?? (rows.some(r => (r.delivery as J | null)?.state === 'APPROVED') ? await approvedMergeRule() : PERSON_MERGES);
    for (const row of rows) {
      const v = rowToDeliveryView(row, Date.now(), needsPerson);
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
 * S35: failed tasks that are replaced work, by the kernel's reading (the rule
 * is `replacedFailedTaskIds` in delivery-display.ts). On a read error the map
 * is empty, so nothing is replaced and the legacy reading shows the failure.
 */
export async function kernelReplacedFailedTaskIds(failedTaskIds: string[], exec: Exec = dbExec): Promise<Set<string>> {
  return replacedFailedTaskIds(await getDeliveryViewsForTasks(failedTaskIds, exec), failedTaskIds);
}

/** Pure half of `kernelReplacedFailedTaskIds`; lives with the client-safe reading. */
export { replacedFailedTaskIds };

/**
 * Slice E (§17.5): taskId → the serialisable `DeliveryDisplay` for each given
 * task that OWNS a kernel-owned delivery. The one load a list surface makes;
 * every chip, tile and badge it draws for those rows projects from it. Never
 * throws (same degradation as `getDeliveryViewsForTasks`).
 */
export async function getOwnerDeliveryDisplays(taskIds: string[], exec: Exec = dbExec): Promise<Map<string, DeliveryDisplay>> {
  return ownerDeliveryDisplays(await getDeliveryViewsForTasks(taskIds, exec));
}
