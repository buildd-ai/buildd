/**
 * Effect handlers of the trunk circuit breaker (docs/specs/workflow-state-kernel.md
 * §6.10, §10.2), reached only through the composition root
 * (`workflowEffectHandlers()` in apps/web/src/modules.ts).
 *
 *  - `dispatch_trunk_fix`: exactly one trunk-fix task per incident. Its task id
 *    IS the incident id, so concurrent drains and replays file it once; the
 *    incident is linked after the task exists (the FK, §13.1 deviation 9).
 *  - `cancel_open_attempts` (reason `blocked_on_trunk`): cancels the per-PR
 *    CI fix tasks that never started; the ledger rows were skipped by T25.
 *
 * T26's mechanical base refresh (`refresh_branch` with no ledger row) is the
 * conflict family's handler (conflict-retry-effects.ts): one handler per kind.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
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
  const prNumbers: number[] = [];
  for (const did of (inc.affected_deliveries ?? []).slice(0, 20)) {
    const d = (await loadView({ deliveryId: did }, dbExec)).delivery;
    if (d?.prNumber != null) prNumbers.push(d.prNumber);
  }
  const [row] = await db.insert(tasks).values({
    id: inc.id,
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
UPDATE trunk_incidents SET trunk_fix_task_id = ${inc.id}::uuid, status = 'fixing', updated_at = now()
WHERE id = ${inc.id}::uuid AND trunk_fix_task_id IS NULL AND status <> 'resolved'
  AND EXISTS (SELECT 1 FROM tasks WHERE id = ${inc.id}::uuid)`);
  if (!row) return { outcome: 'ok:task_exists' };
  await announceTaskCreated(row as never, workspace as never);
  await wakeTask(row.id, 'task.created');
  return { outcome: 'ok' };
};

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
