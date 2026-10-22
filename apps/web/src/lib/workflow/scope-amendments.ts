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
 *    a hold on the task (`context.heldBy`, the claim gate's single-task hold,
 *    naming the mission) and one mission note asking a person.
 *
 * The decision is asked when the task is filed into the mission and when an
 * existing task is linked to it (`origin: 'linked'`). A held decision is
 * answered once (`resolveTaskScope`): it fits, it changes the mission (the
 * amendment applies, compare-and-set like any other), it belongs elsewhere
 * (the task is cancelled), or the task left the mission (`withdrawn`). Every
 * answer releases the hold that decision placed and answers its note.
 *
 * Reached from outside the kernel through the seam (`kernel-client`'s
 * `mission_scope` op) and `delivery-ship` (reads).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { decideAndRecord } from '@buildd/workflow-kernel/decide';
import {
  MISSION_SCOPE_POINT, SCOPE_HOLD_REASON, clipScopeText, planScope, planScopeResolution, scopeHold,
  type ScopeCriterion, type ScopePlan, type ScopeProposal, type ScopeResolutionPlan,
} from '@buildd/workflow-kernel/scope-amendments';
import type { Decide, Store } from '@buildd/workflow-kernel/ports';
import { handWrittenCriteriaRefusal, outcomeSpecWriteRefusal } from '@buildd/core/mission-helpers';
import type { Exec } from './kernel';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export { SCOPE_HOLD_REASON };

/** Every scope question note's title ends so: how an answer finds the note it answers. */
export const SCOPE_QUESTION_SUFFIX = ' change what this mission delivers?';

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
  resolution: string | null;
  createdAt: string;
}

export function scopeAmendmentsSql(missionIds: string[]): SQL {
  return sql`-- workflow:scope_amendments
SELECT id, mission_id, source_task_id, decision, status, scope_version_before, scope_version_after, reason, weakens, resolution, created_at
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
      resolution: r.resolution == null ? null : String(r.resolution),
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
  UPDATE tasks SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('heldBy', ${json(scopeHold(p.missionId, hold.at))}),
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
  parent_mode: string | null; parent_mission_id: string | null;
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

/**
 * The proposal as this mission may take it. An amendment writes the mission
 * row directly, so it is held to the same write boundary as PATCH
 * /api/missions: proposed criteria that would start hand-written criteria on a
 * mission holding none (Living Specs D-44), or drop or change its outcome
 * spec, are ignored and the mission keeps its own. The description still moves.
 */
export function admissibleProposal(proposal: ScopeProposal | null, stored: ScopeCriterion[] | null): ScopeProposal | null {
  if (!proposal || proposal.goalCriteria === undefined) return proposal;
  const refused = handWrittenCriteriaRefusal(stored, proposal.goalCriteria) ?? outcomeSpecWriteRefusal(stored, proposal.goalCriteria);
  return refused ? { ...proposal, goalCriteria: undefined } : proposal;
}

const labelOf = (c: ScopeCriterion): string => c.label?.trim() || (c.type === 'description' ? String(c.description ?? '') : c.type === 'command' ? `command: ${c.command ?? ''}` : c.type);

async function taskRow(exec: Exec, taskId: string): Promise<TaskRow | undefined> {
  return (((await exec(sql`-- workflow:scope_task
SELECT t.id, t.title, t.description, t.mission_id, t.workspace_id, t.task_class, t.mode, t.creation_source, t.context,
  pt.mode AS parent_mode, pt.mission_id AS parent_mission_id
FROM tasks t LEFT JOIN tasks pt ON pt.id = t.parent_task_id
WHERE t.id = ${taskId}::uuid`)).rows ?? []) as TaskRow[])[0];
}

async function missionRow(exec: Exec, missionId: string): Promise<MissionRow | undefined> {
  return (((await exec(sql`-- workflow:scope_mission
SELECT id, title, description, goal_criteria, scope_version, status, team_id, workspace_id FROM missions WHERE id = ${missionId}::uuid`)).rows ?? []) as MissionRow[])[0];
}

const missionScope = (m: MissionRow) => ({ description: m.description, goalCriteria: m.goal_criteria, scopeVersion: Number(m.scope_version ?? 1) });

/**
 * Is this task the organizer decomposing the mission's own brief (the
 * contract, not a change to it)? A task filed by the organizer, a conflict
 * fix, or a child of a planning task is. A task linked from elsewhere is
 * only when its planning parent belongs to this same mission: work the
 * organizer planned for another mission, moved here, is new to this one.
 */
function isOrganizerDecomposition(task: TaskRow, origin: 'filed' | 'linked'): boolean {
  if (origin === 'linked') return task.parent_mode === 'planning' && task.parent_mission_id === task.mission_id;
  return task.creation_source === 'orchestrator' || task.creation_source === 'conflict' || task.parent_mode === 'planning';
}

/**
 * Decide the scope of a task added to a mission, once, and write what it
 * means. Idempotent: a second call for the same task reads the recorded
 * decision and writes nothing new. `origin` is how it was added: filed into
 * the mission (the default) or linked to it (`manage_missions link_task`, a
 * task PATCH setting `missionId`); both get the same decision and the same
 * compare-and-set on the mission's scope version.
 */
export async function decideTaskScope(p: { taskId: string; actor: string; origin?: 'filed' | 'linked' }, deps: ScopeDeps = {}): Promise<ScopeOutcome> {
  const exec = deps.exec ?? dbExec;
  const task = await taskRow(exec, p.taskId);
  if (!task) return { decided: false, reason: 'not_found' };
  if (!task.mission_id) return { decided: false, reason: 'not_in_mission' };
  if (task.task_class !== 'work' || task.mode === 'planning') return { decided: false, reason: 'not_deliverable' };
  const proposal = proposalOf(task.context);
  if (!proposal && isOrganizerDecomposition(task, p.origin ?? 'filed')) return { decided: false, reason: 'organizer_decomposition' };

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
    const mission = await missionRow(exec, task.mission_id);
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
      mission: missionScope(mission), task: { id: task.id, title: task.title }, proposal: admissibleProposal(proposal, mission.goal_criteria),
    });
    const at = (deps.now ?? (() => new Date()))().toISOString();
    const hold = plan.status === 'held' ? {
      at,
      noteTitle: `Does "${clipScopeText(task.title, 120)}"${SCOPE_QUESTION_SUFFIX}`,
      noteBody: [
        `"${task.title}" was added to this mission and is on hold until you decide, because ${plan.decision === 'ask' ? 'buildd could not tell whether it fits the mission as written' : plan.reason}.`,
        '',
        '- It fits the mission as written: resume the task.',
        `- It changes the mission: accept the change on the task${plan.weakens.length > 0 ? ' (this removes or loosens the checks named above)' : ''}, or edit the mission's description or goals yourself, then resume the task.`,
        '- It belongs elsewhere: cancel the task, or move it to another mission.',
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

// ── A person's answer to a held decision ────────────────────────────────────

export type ScopeAnswerOutcome =
  | { resolved: false; reason: 'not_found' | 'no_decision' | 'not_in_mission' | 'invalid_answer' }
  | { resolved: true; replayed: boolean; resolution: string; scopeVersion: number; cancelled: boolean };

/**
 * The answer as one statement. The row moves from `held` to `resolved` only
 * once; an accepted amendment moves the mission only if it is still at the
 * version the plan read (and the open delivery with no PR yet takes the new
 * version), and the row moves only if that happened. The task's hold is
 * released only when it is the one this mission's decision placed; `out of
 * scope` also cancels a task still pending. The decision's open question
 * note is answered.
 */
export function resolveScopeSql(p: { missionId: string; taskId: string; plan: Extract<ScopeResolutionPlan, { act: true }>; actor: string }): SQL {
  const { missionId, taskId, plan } = p;
  const amend = plan.amend;
  const heldRow = sql`SELECT 1 FROM workflow_scope_amendments WHERE mission_id = ${missionId}::uuid AND source_task_id = ${taskId}::uuid AND status = 'held'`;
  const ours = sql`(t.context->'heldBy'->>'reason' = ${SCOPE_HOLD_REASON}::text AND COALESCE(t.context->'heldBy'->>'missionId', ${missionId}::text) = ${missionId}::text)`;
  const cancel = sql`(${plan.cancelTask}::boolean AND t.status = 'pending')`;
  return sql`-- workflow:scope_resolve
WITH ${amend ? sql`m AS (
  UPDATE missions SET description = ${amend.after.description}::text, goal_criteria = ${json(amend.after.goalCriteria)},
    scope_version = ${amend.scopeVersionAfter}::int, updated_at = now()
  WHERE id = ${missionId}::uuid AND scope_version = ${amend.scopeVersionBefore}::int AND EXISTS (${heldRow})
  RETURNING id),
e AS (
  UPDATE workflow_mission_epochs SET scope_version = ${amend.scopeVersionAfter}::int, version = version + 1, updated_at = now()
  WHERE mission_id = ${missionId}::uuid AND state = 'open' AND pr_number IS NULL AND EXISTS (SELECT 1 FROM m)
  RETURNING id),
` : sql``}r AS (
  UPDATE workflow_scope_amendments SET status = 'resolved', resolution = ${plan.resolution}::text, resolved_at = now(), resolved_by = ${p.actor}::text${amend ? sql`,
    scope_version_after = ${amend.scopeVersionAfter}::int, after = ${json(amend.after)}, weakens = ${json(amend.weakens)}` : sql``}
  WHERE mission_id = ${missionId}::uuid AND source_task_id = ${taskId}::uuid AND status = 'held'${amend ? sql` AND EXISTS (SELECT 1 FROM m)` : sql``}
  RETURNING id),
h AS (
  UPDATE tasks t SET
    context = CASE WHEN ${ours} THEN t.context - 'heldBy' ELSE t.context END,
    status = CASE WHEN ${cancel} THEN 'cancelled' ELSE t.status END,
    updated_at = now()
  WHERE t.id = ${taskId}::uuid AND EXISTS (SELECT 1 FROM r) AND (${ours} OR ${cancel})
  RETURNING t.status),
n AS (
  UPDATE mission_notes SET status = 'answered'
  WHERE mission_id = ${missionId}::uuid AND task_id = ${taskId}::uuid AND author_type = 'system' AND type = 'question' AND status = 'open'
    AND title LIKE ${`%${SCOPE_QUESTION_SUFFIX}`}::text AND EXISTS (SELECT 1 FROM r)
  RETURNING id)
SELECT EXISTS (SELECT 1 FROM r) AS written, (SELECT status FROM h LIMIT 1) AS task_status`;
}

/**
 * Record the answer to a held scope decision of task `taskId` in mission
 * `missionId`, once, and do what it means. Idempotent: an answered decision
 * is read back (`replayed`), never answered again. A person answers only for
 * a task still in the mission; `withdrawn` is for one that left it.
 */
export async function resolveTaskScope(
  p: { missionId: string; taskId: string; answer: string; actor: string },
  deps: Pick<ScopeDeps, 'exec'> = {},
): Promise<ScopeAnswerOutcome> {
  const exec = deps.exec ?? dbExec;
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = ((await exec(sql`-- workflow:scope_existing
SELECT status, resolution, scope_version_after, scope_version_before FROM workflow_scope_amendments
WHERE mission_id = ${p.missionId}::uuid AND source_task_id = ${p.taskId}::uuid`)).rows ?? [])[0] as Record<string, unknown> | undefined;
    if (!row) return { resolved: false, reason: 'no_decision' };
    const scopeVersion = Number(row.scope_version_after ?? row.scope_version_before);
    if (row.status === 'resolved') return { resolved: true, replayed: true, resolution: String(row.resolution ?? ''), scopeVersion, cancelled: false };
    const task = await taskRow(exec, p.taskId);
    const mission = await missionRow(exec, p.missionId);
    if (!task || !mission) return { resolved: false, reason: 'not_found' };
    if (p.answer !== 'withdrawn' && task.mission_id !== p.missionId) return { resolved: false, reason: 'not_in_mission' };
    const plan = planScopeResolution({
      answer: p.answer, held: { status: String(row.status) }, mission: missionScope(mission),
      task: { id: task.id, title: task.title }, proposal: admissibleProposal(proposalOf(task.context), mission.goal_criteria),
    });
    if (!plan.act) return plan.reason === 'not_held' ? { resolved: false, reason: 'no_decision' } : { resolved: false, reason: plan.reason };
    const r = ((await exec(resolveScopeSql({ missionId: p.missionId, taskId: p.taskId, plan, actor: p.actor }))).rows ?? [])[0] as
      { written?: unknown; task_status?: unknown } | undefined;
    if (r?.written === true || r?.written === 't') {
      return {
        resolved: true, replayed: false, resolution: plan.resolution,
        scopeVersion: plan.amend?.scopeVersionAfter ?? scopeVersion, cancelled: plan.cancelTask && r.task_status === 'cancelled',
      };
    }
    // Another amendment moved the mission, or another answer landed first: read again.
  }
  throw new Error(`scope answer for task ${p.taskId} did not converge`);
}
