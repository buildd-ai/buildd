/**
 * Mission scope amendments, the host half (docs/specs/workflow-kernel-library.md
 * §6 "Scope amendments"; task f3bda4e1 part 2).
 *
 * The one writer of `workflow_scope_amendments`. When a deliverable task is
 * added to a mission, the scope decision is asked once at the `mission_scope`
 * point through the Decide port (`decideAndRecord`), so it is a recorded fact
 * a replay reads instead of asking again. The package's `planScope` turns it
 * into what is written, in ONE statement:
 *
 *  - in scope: the decision row, nothing else;
 *  - amend scope: the row, the mission's description / goal criteria and its
 *    scope version (compare-and-set on the version the plan read), and the
 *    open delivery's scope version when that delivery has no PR yet (one in
 *    review keeps the version it was reviewed under; the next one carries the
 *    new version from the mission row);
 *  - held (ask, or an amendment that weakens a completion criterion): the row,
 *    a hold on the task (`context.heldBy`, the claim gate's single-task hold)
 *    and one mission note asking a person.
 *
 * Reached from outside the kernel through the seam (`kernel-client`'s
 * `mission_scope` op) and `delivery-ship` (reads).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { decideAndRecord } from '@buildd/workflow-kernel/decide';
import {
  MISSION_SCOPE_POINT, clipScopeText, planScope, type ScopeCriterion, type ScopePlan, type ScopeProposal,
} from '@buildd/workflow-kernel/scope-amendments';
import type { Decide, Store } from '@buildd/workflow-kernel/ports';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export const SCOPE_HOLD_REASON = 'mission_scope_decision';

export interface ScopeAmendmentRow {
  id: string;
  missionId: string;
  sourceTaskId: string | null;
  decision: string;
  status: string;
  scopeVersionBefore: number;
  scopeVersionAfter: number | null;
  reason: string | null;
  weakens: Array<{ criterion: string; how: string }>;
  createdAt: string;
}

export function scopeAmendmentsSql(missionIds: string[]): SQL {
  return sql`-- workflow:scope_amendments
SELECT id, mission_id, source_task_id, decision, status, scope_version_before, scope_version_after, reason, weakens, created_at
FROM workflow_scope_amendments
WHERE mission_id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(missionIds)}::jsonb))::uuid)
ORDER BY mission_id, created_at`;
}

/** missionId → its scope decisions, oldest first. */
export async function scopeAmendmentsFor(missionIds: string[], exec: Exec = dbExec): Promise<Map<string, ScopeAmendmentRow[]>> {
  const out = new Map<string, ScopeAmendmentRow[]>();
  if (missionIds.length === 0) return out;
  for (const r of ((await exec(scopeAmendmentsSql(missionIds))).rows ?? []) as Array<Record<string, unknown>>) {
    const row: ScopeAmendmentRow = {
      id: String(r.id), missionId: String(r.mission_id), sourceTaskId: r.source_task_id == null ? null : String(r.source_task_id),
      decision: String(r.decision), status: String(r.status), scopeVersionBefore: Number(r.scope_version_before),
      scopeVersionAfter: r.scope_version_after == null ? null : Number(r.scope_version_after),
      reason: r.reason == null ? null : String(r.reason),
      weakens: Array.isArray(r.weakens) ? (r.weakens as Array<{ criterion: string; how: string }>) : [],
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
    out.set(row.missionId, [...(out.get(row.missionId) ?? []), row]);
  }
  return out;
}

const json = (v: unknown): SQL => sql`${JSON.stringify(v ?? null)}::jsonb`;

/**
 * The plan as one statement. An applied amendment moves the mission only if
 * it is still at the version the plan read and this task has no decision yet;
 * the row is written only if that move happened (or for a recorded / held
 * plan, only once per task). Returns `written = false` when nothing matched.
 */
export function recordScopeSql(p: {
  missionId: string; taskId: string; plan: ScopePlan; factId: string | null;
  deciderId: string | null; confidence: number | null; fallback: string | null; actor: string;
  hold: { at: string; noteTitle: string; noteBody: string } | null;
}): SQL {
  const pl = p.plan;
  const row = sql`${p.missionId}::uuid, ${p.taskId}::uuid, ${pl.decision}::text, ${pl.status}::text, ${pl.scopeVersionBefore}::int,
    ${pl.scopeVersionAfter}::int, ${json(pl.before)}, ${json(pl.after)}, ${json(pl.weakens)}, ${pl.reason}::text,
    ${p.factId}::uuid, ${p.deciderId}::text, ${p.confidence}::real, ${p.fallback}::text, ${p.actor}::text`;
  const cols = sql`(mission_id, source_task_id, decision, status, scope_version_before, scope_version_after, before, after, weakens,
    reason, decision_fact_id, decider_id, confidence, fallback, actor)`;
  if (pl.status === 'applied') {
    return sql`-- workflow:scope_amend
WITH m AS (
  UPDATE missions SET description = ${pl.after?.description ?? null}::text, goal_criteria = ${json(pl.after?.goalCriteria ?? null)},
    scope_version = ${pl.scopeVersionAfter}::int, updated_at = now()
  WHERE id = ${p.missionId}::uuid AND scope_version = ${pl.scopeVersionBefore}::int
    AND NOT EXISTS (SELECT 1 FROM workflow_scope_amendments WHERE mission_id = ${p.missionId}::uuid AND source_task_id = ${p.taskId}::uuid)
  RETURNING id),
e AS (
  UPDATE workflow_mission_epochs SET scope_version = ${pl.scopeVersionAfter}::int, version = version + 1, updated_at = now()
  WHERE mission_id = ${p.missionId}::uuid AND state = 'open' AND pr_number IS NULL AND EXISTS (SELECT 1 FROM m)
  RETURNING id),
a AS (
  INSERT INTO workflow_scope_amendments ${cols}
  SELECT ${row} WHERE EXISTS (SELECT 1 FROM m)
  ON CONFLICT (mission_id, source_task_id) DO NOTHING
  RETURNING id)
SELECT EXISTS (SELECT 1 FROM a) AS written`;
  }
  const hold = p.hold;
  return sql`-- workflow:scope_record
WITH a AS (
  INSERT INTO workflow_scope_amendments ${cols}
  SELECT ${row}
  ON CONFLICT (mission_id, source_task_id) DO NOTHING
  RETURNING id)${hold ? sql`,
h AS (
  UPDATE tasks SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('heldBy', jsonb_build_object('at', ${hold.at}::text, 'userId', NULL, 'reason', ${SCOPE_HOLD_REASON}::text)),
    updated_at = now()
  WHERE id = ${p.taskId}::uuid AND status = 'pending' AND EXISTS (SELECT 1 FROM a)
  RETURNING id),
n AS (
  INSERT INTO mission_notes (mission_id, task_id, author_type, type, title, body, status)
  SELECT ${p.missionId}::uuid, ${p.taskId}::uuid, 'system', 'question', ${hold.noteTitle}::text, ${hold.noteBody}::text, 'open'
  WHERE EXISTS (SELECT 1 FROM a)
  RETURNING id)` : sql``}
SELECT EXISTS (SELECT 1 FROM a) AS written`;
}

export interface ScopeDeps {
  exec?: Exec;
  store?: Store;
  decide?: Decide;
  now?: () => Date;
}

export type ScopeOutcome =
  | { decided: false; reason: 'not_found' | 'not_in_mission' | 'not_deliverable' | 'organizer_decomposition' | 'mission_terminal' }
  | { decided: true; replayed: boolean; decision: string; status: string; scopeVersion: number; reason: string };

interface TaskRow {
  id: string; title: string; description: string | null; mission_id: string | null; workspace_id: string;
  task_class: string | null; mode: string | null; creation_source: string | null; context: Record<string, unknown> | null;
  parent_mode: string | null;
}
interface MissionRow {
  id: string; title: string; description: string | null; goal_criteria: ScopeCriterion[] | null; scope_version: number;
  status: string; team_id: string; workspace_id: string | null;
}

/** The filer's proposal, when it attached one (`context.missionScope`). */
function proposalOf(context: Record<string, unknown> | null): ScopeProposal | null {
  const p = context?.missionScope;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  return {
    description: typeof o.description === 'string' ? o.description : null,
    goalCriteria: Array.isArray(o.goalCriteria) ? (o.goalCriteria as ScopeCriterion[]) : o.goalCriteria === null ? null : undefined,
    reason: typeof o.reason === 'string' ? o.reason : null,
  };
}

const labelOf = (c: ScopeCriterion): string => c.label?.trim() || (c.type === 'description' ? String(c.description ?? '') : c.type === 'command' ? `command: ${c.command ?? ''}` : c.type);

/**
 * Decide the scope of a task added to a mission, once, and write what it
 * means. Idempotent: a second call for the same task reads the recorded
 * decision and writes nothing new.
 */
export async function decideTaskScope(p: { taskId: string; actor: string }, deps: ScopeDeps = {}): Promise<ScopeOutcome> {
  const exec = deps.exec ?? dbExec;
  const [task] = ((await exec(sql`-- workflow:scope_task
SELECT t.id, t.title, t.description, t.mission_id, t.workspace_id, t.task_class, t.mode, t.creation_source, t.context, pt.mode AS parent_mode
FROM tasks t LEFT JOIN tasks pt ON pt.id = t.parent_task_id
WHERE t.id = ${p.taskId}::uuid`)).rows ?? []) as TaskRow[];
  if (!task) return { decided: false, reason: 'not_found' };
  if (!task.mission_id) return { decided: false, reason: 'not_in_mission' };
  if (task.task_class !== 'work' || task.mode === 'planning') return { decided: false, reason: 'not_deliverable' };
  const proposal = proposalOf(task.context);
  // The organizer decomposing its own brief is the contract, not a change to it.
  if (!proposal && (task.creation_source === 'orchestrator' || task.creation_source === 'conflict' || task.parent_mode === 'planning')) {
    return { decided: false, reason: 'organizer_decomposition' };
  }

  const { workflowKernel } = await import('./kernel-ports');
  const kernel = deps.store && deps.decide ? null : await workflowKernel();
  const store = deps.store ?? kernel!.ports.store;
  const decide = deps.decide ?? kernel!.ports.decide;

  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = ((await exec(sql`-- workflow:scope_existing
SELECT decision, status, scope_version_after, scope_version_before, reason FROM workflow_scope_amendments
WHERE mission_id = ${task.mission_id}::uuid AND source_task_id = ${task.id}::uuid`)).rows ?? [])[0] as Record<string, unknown> | undefined;
    if (existing) {
      return {
        decided: true, replayed: true, decision: String(existing.decision), status: String(existing.status),
        scopeVersion: Number(existing.scope_version_after ?? existing.scope_version_before), reason: String(existing.reason ?? ''),
      };
    }
    const [mission] = ((await exec(sql`-- workflow:scope_mission
SELECT id, title, description, goal_criteria, scope_version, status, team_id, workspace_id FROM missions WHERE id = ${task.mission_id}::uuid`)).rows ?? []) as MissionRow[];
    if (!mission) return { decided: false, reason: 'not_found' };
    if (mission.status === 'archived') return { decided: false, reason: 'mission_terminal' };
    const merged = Number((((await exec(sql`-- workflow:scope_deliveries
SELECT count(*) AS n FROM workflow_mission_epochs WHERE mission_id = ${mission.id}::uuid AND state = 'merged'`)).rows ?? [])[0] as { n?: unknown } | undefined)?.n ?? 0);

    const features = {
      missionTitle: clipScopeText(mission.title, 300), missionDescription: clipScopeText(mission.description),
      criteria: (mission.goal_criteria ?? []).slice(0, 20).map(labelOf).map((s) => clipScopeText(s, 200)),
      taskTitle: clipScopeText(task.title, 300), taskDescription: clipScopeText(task.description), deliveriesMerged: merged, proposed: !!proposal,
    };
    const workspaceId = mission.workspace_id ?? task.workspace_id;
    const { fact, factId } = await decideAndRecord(
      store,
      { workspaceId, deliveryId: `mission:${mission.id}`, source: 'mission_scope' },
      MISSION_SCOPE_POINT,
      { taskId: task.id, ...features, features, scope: { teamId: mission.team_id, workspaceId, missionId: mission.id } },
      { decide },
    );
    const plan = planScope({
      verdict: fact.verdict, reason: fact.reason,
      mission: { description: mission.description, goalCriteria: mission.goal_criteria, scopeVersion: Number(mission.scope_version ?? 1) },
      task: { id: task.id, title: task.title }, proposal,
    });
    const at = (deps.now ?? (() => new Date()))().toISOString();
    const hold = plan.status === 'held' ? {
      at,
      noteTitle: `Does "${clipScopeText(task.title, 120)}" change what this mission delivers?`,
      noteBody: [
        `"${task.title}" was added to this mission and is on hold until you decide, because ${plan.decision === 'ask' ? 'buildd could not tell whether it fits the mission as written' : plan.reason}.`,
        '',
        '- It fits the mission as written: resume the task.',
        `- It changes the mission: edit the mission's description or goals${plan.weakens.length > 0 ? ' (keeping the checks it would have weakened, or removing them yourself)' : ''}, then resume the task.`,
        '- It belongs elsewhere: move or cancel the task.',
      ].join('\n'),
    } : null;
    const r = ((await exec(recordScopeSql({
      missionId: mission.id, taskId: task.id, plan, factId, deciderId: fact.deciderId, confidence: fact.confidence,
      fallback: fact.fallback, actor: p.actor, hold,
    }))).rows ?? [])[0] as { written?: unknown } | undefined;
    if (r?.written === true || r?.written === 't') {
      return {
        decided: true, replayed: false, decision: plan.decision, status: plan.status,
        scopeVersion: plan.scopeVersionAfter ?? plan.scopeVersionBefore, reason: plan.reason,
      };
    }
    // Another amendment moved the mission, or another caller recorded this task: read again.
  }
  throw new Error(`scope decision for task ${p.taskId} did not converge`);
}
