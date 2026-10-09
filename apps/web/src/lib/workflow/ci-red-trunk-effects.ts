/**
 * Effect handlers of the trunk circuit breaker (docs/specs/workflow-state-kernel.md
 * §6.10, §10.2), reached only through the composition root
 * (`workflowEffectHandlers()` in apps/web/src/modules.ts).
 *
 *  - `dispatch_trunk_fix`: one open trunk-fix task per red base, not per
 *    incident. A base can hold several open incidents at once (one per
 *    signature: its runs were read before every check finished, or its head
 *    moved and broke more), and each one used to file its own fixer. The task
 *    id is the id of the base's oldest unresolved incident whose fixer is not
 *    finished (`trunkFixAnchorSql`), so every incident of one episode, and
 *    concurrent drains and replays, insert the same row and file it once; a
 *    later incident joins that fixer and steers it with the checks it was not
 *    filed for. Resolved incidents never anchor, so a red after recovery files
 *    a fix of its own. The incident is linked after the task exists (the FK,
 *    §13.1 deviation 9).
 *  - `cancel_open_attempts` (reason `blocked_on_trunk`): cancels the per-PR
 *    CI fix tasks that never started; the ledger rows were skipped by T25.
 *
 * T26's mechanical base refresh (`refresh_branch` with no ledger row) is the
 * conflict family's handler (conflict-retry-effects.ts): one handler per kind.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { TERMINAL_TASK_STATUSES, TERMINAL_WORKER_STATUSES } from '@buildd/shared';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { queueSystemInstruction } from '@/lib/system-instruction-queue';
import type { EffectHandler, EffectHandlers } from './effects';
import { loadView, type Exec } from './kernel';
import { githubReader, workspaceRepo } from './github-facts';
import { signatureChecks, trunkRecovered } from './trunk';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

interface IncidentRow { id: string; workspace_id: string; repo_full_name: string; base_ref: string; signature: string; status: string; trunk_fix_task_id: string | null; affected_deliveries: string[] }

async function incident(id: string): Promise<IncidentRow | null> {
  const rows = ((await dbExec(sql`-- workflow:trunk_incident
SELECT id, workspace_id, repo_full_name, base_ref, signature, status, trunk_fix_task_id, affected_deliveries FROM trunk_incidents WHERE id = ${id}::uuid`)).rows ?? []) as IncidentRow[];
  return rows[0] ?? null;
}

/**
 * The trunk-fix task this incident belongs to: the oldest unresolved incident on
 * the same base whose fix is not finished (no task yet, or a task still open),
 * falling back to the incident itself. Its linked task when it has one, else its
 * own id, which is the id its own dispatch files under. One statement, no
 * interactive transaction (neon-http): every incident of one red base resolves
 * to the same id, and the task insert's primary key makes it one row.
 */
export function trunkFixAnchorSql(incidentId: string): SQL {
  const terminal = sql.join(TERMINAL_TASK_STATUSES.map((s) => sql`${s}::text`), sql`, `);
  return sql`-- workflow:trunk_fix_anchor
SELECT COALESCE(o.trunk_fix_task_id, o.id) AS task_id, o.id AS incident_id, t.context->>'signature' AS fix_signature
FROM trunk_incidents me
JOIN trunk_incidents o ON o.workspace_id = me.workspace_id AND o.repo_full_name = me.repo_full_name AND o.base_ref = me.base_ref
  AND o.status <> 'resolved'
LEFT JOIN tasks t ON t.id = o.trunk_fix_task_id
WHERE me.id = ${incidentId}::uuid
  AND (o.id = me.id OR (o.trunk_fix_task_id IS NULL AND (o.first_seen_at, o.id) < (me.first_seen_at, me.id)) OR t.status NOT IN (${terminal}))
ORDER BY (o.first_seen_at, o.id)
LIMIT 1`;
}

export function trunkFixTitle(baseRef: string, signature: string): string {
  const checks = signatureChecks(signature);
  return `fix(ci): ${baseRef} is red — ${checks.length ? checks.slice(0, 3).join(', ') : 'CI'}${checks.length > 3 ? ` +${checks.length - 3}` : ''}`;
}

export function trunkFixDescription(p: { repoFullName: string; baseRef: string; baseHeadSha: string | null; signature: string; prNumbers: number[] }): string {
  const checks = signatureChecks(p.signature);
  return [
    `The base branch \`${p.baseRef}\` of ${p.repoFullName} fails CI on its own head${p.baseHeadSha ? ` (\`${p.baseHeadSha.slice(0, 12)}\`)` : ''}, and open PRs fail the same checks because of it. Their per-PR CI retries are paused until the base is green again (the trunk circuit breaker).`,
    '',
    '## Failing checks',
    ...(checks.length ? checks.map((c) => `- ${c}`) : ['- (not named)']),
    '',
    '## Instructions',
    `1. Branch from the current \`${p.baseRef}\` and reproduce the failure locally.`,
    '2. Fix the cause on the base branch itself (a time-dependent test, a broken dependency, a bad merge). Change nothing unrelated.',
    `3. Open a PR into \`${p.baseRef}\`. Once it merges and CI on \`${p.baseRef}\` is green, every blocked PR resumes on its own.`,
    '',
    p.prNumbers.length ? `Blocked PRs: ${p.prNumbers.map((n) => `#${n}`).join(', ')}` : '',
  ].join('\n');
}

const dispatchTrunkFix: EffectHandler = async (e) => {
  const inc = await incident(String(e.payload.incidentId ?? ''));
  if (!inc) return { outcome: 'skipped:no_incident' };
  if (inc.status === 'resolved') return { outcome: 'skipped:resolved' };
  if (inc.trunk_fix_task_id) return { outcome: 'ok:task_exists' };
  const repo = await workspaceRepo(inc.workspace_id);
  if (!repo) throw new Error('no GitHub installation for the workspace');
  const reader = githubReader(repo.installationId);
  const baseHead = reader.branchHead ? await reader.branchHead(inc.repo_full_name, inc.base_ref) : null;
  // §10.5 at dispatch: a base that is already green owes no fix; the recovery sweep resolves the incident.
  const runs = baseHead && reader.checkRuns ? await reader.checkRuns(inc.repo_full_name, baseHead) : null;
  if (runs?.complete && trunkRecovered(inc.signature, runs.failing)) return { outcome: 'skipped:trunk_green' };

  const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, inc.workspace_id) });
  if (!workspace) return { outcome: 'skipped:no_workspace' };
  const anchor = ((await dbExec(trunkFixAnchorSql(inc.id))).rows ?? [])[0] as { task_id: string; incident_id: string; fix_signature: string | null } | undefined;
  const taskId = String(anchor?.task_id ?? inc.id);
  const prNumbers: number[] = [];
  for (const did of (inc.affected_deliveries ?? []).slice(0, 20)) {
    const d = (await loadView({ deliveryId: did }, dbExec)).delivery;
    if (d?.prNumber != null) prNumbers.push(d.prNumber);
  }
  const [row] = await db.insert(tasks).values({
    id: taskId,
    workspaceId: inc.workspace_id,
    title: trunkFixTitle(inc.base_ref, inc.signature),
    description: trunkFixDescription({ repoFullName: inc.repo_full_name, baseRef: inc.base_ref, baseHeadSha: baseHead, signature: inc.signature, prNumbers }),
    category: 'bug',
    kind: 'engineering',
    creationSource: 'webhook',
    outputRequirement: 'pr_required',
    status: 'pending',
    priority: 9,
    context: { trunkIncidentId: inc.id, baseBranch: inc.base_ref, signature: inc.signature, baseHeadSha: baseHead },
  } as never).onConflictDoNothing().returning();
  await dbExec(sql`-- workflow:trunk_link_fix
UPDATE trunk_incidents SET trunk_fix_task_id = ${taskId}::uuid, status = 'fixing', updated_at = now()
WHERE id = ${inc.id}::uuid AND trunk_fix_task_id IS NULL AND status <> 'resolved'
  AND EXISTS (SELECT 1 FROM tasks WHERE id = ${taskId}::uuid)`);
  if (row) {
    await announceTaskCreated(row as never, workspace as never);
    await wakeTask(row.id, 'task.created');
    return { outcome: 'ok' };
  }
  if (taskId === inc.id) return { outcome: 'ok:task_exists' };
  await steerTrunkFixer(taskId, inc, anchor?.fix_signature ?? null);
  return { outcome: 'ok:joined_open_fix' };
};

/**
 * Tell the fixer an incident joined about the checks it was not filed for: on
 * the task's description (read at claim, if nobody has it yet) and on the
 * instruction queue of any live worker. Both writes are idempotent per incident.
 */
async function steerTrunkFixer(taskId: string, inc: IncidentRow, fixSignature: string | null): Promise<void> {
  const known = new Set(fixSignature ? signatureChecks(fixSignature) : []);
  const extra = signatureChecks(inc.signature).filter((c) => !known.has(c));
  if (!extra.length) return;
  const marker = `trunk-incident:${inc.id}`;
  const note = `<!-- ${marker} -->\nThe base branch \`${inc.base_ref}\` now also fails: ${extra.join(', ')}. One trunk fix covers every failing check on this base, so fix these in the same PR; no second fix task was filed.`;
  await dbExec(sql`-- workflow:trunk_steer_fix
UPDATE tasks SET description = COALESCE(description, '') || E'\n\n' || ${note}::text, updated_at = now()
WHERE id = ${taskId}::uuid AND strpos(COALESCE(description, ''), ${marker}::text) = 0`);
  const terminal = sql.join(TERMINAL_WORKER_STATUSES.map((s) => sql`${s}::text`), sql`, `);
  const live = ((await dbExec(sql`-- workflow:trunk_fixer_workers
SELECT id FROM workers WHERE task_id = ${taskId}::uuid AND status NOT IN (${terminal})`)).rows ?? []) as Array<{ id: string }>;
  for (const w of live) await queueSystemInstruction(String(w.id), note, { marker });
}

/** Per-PR CI fix tasks that never started: T25 skipped their ledger rows. */
const cancelBlockedCiTasks: EffectHandler = async (e) => {
  const rows = await db.update(tasks)
    .set({
      status: 'cancelled',
      result: sql`COALESCE(${tasks.result}, '{}'::jsonb) || jsonb_build_object('skipped', true, 'skipReason', 'blocked_on_trunk', 'summary', 'Skipped: the base branch is red on the same checks (trunk incident)'::text)`,
      updatedAt: new Date(),
    })
    .where(and(eq(tasks.deliveryId, e.deliveryId), eq(tasks.deliveryRole, 'ci_fix'), eq(tasks.status, 'pending')))
    .returning({ id: tasks.id });
  return { outcome: `ok:cancelled_${rows.length}` };
};

/** The CI handlers plus the trunk breaker: what the composition root registers. */
export function withTrunkEffects(base: EffectHandlers): EffectHandlers {
  return {
    ...base,
    dispatch_trunk_fix: dispatchTrunkFix,
    cancel_open_attempts: async (e) => (e.payload.reason === 'blocked_on_trunk'
      ? cancelBlockedCiTasks(e)
      : (base.cancel_open_attempts ? base.cancel_open_attempts(e) : { outcome: 'skipped:no_handler' })),
  };
}

// Exported for tests.
export const __trunkHandlers = { dispatchTrunkFix, cancelBlockedCiTasks };
