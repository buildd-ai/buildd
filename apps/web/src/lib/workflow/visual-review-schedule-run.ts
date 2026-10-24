/**
 * Server half of the visual-review scheduler: loads the facts, asks
 * `planVisualReviewSchedule`, executes the answer through the one existing
 * writer (`requestMissionSurfaceAudit`, idempotent on the audit task).
 *
 * Triggers: the cron sweep over open missions with an integration PR
 * (`sweepVisualReviewSchedule`), and any door that refuses a mission PR for an
 * owed review (`guardMissionPrMerge` via `ready-to-merge.ts`) so the review is
 * on its way the first time anything tries to land the branch.
 */
import 'server-only';
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { missions, tasks, workflowDeliveries, workspaces } from '@buildd/core/db/schema';
import { isTerminalTaskStatus, VISUAL_AUDITOR_ROLE_SLUG, visualReviewPolicyOf, type VisualReviewModel } from '@buildd/shared';
import { requestMissionSurfaceAudit } from '@/lib/mission-surface-audit';
import { repoFor, loadSurfaceAuditGateTasksByMission, loadSurfaceAuditWaivers, type SurfaceAuditGateTask, type SurfaceAuditWaiver } from '@/lib/mission-surface-audit-gate';
import { loadBrowserRunnerHeartbeats } from '@/lib/runner-heartbeats';
import { loadVisualReviews } from '@/lib/visual-review-load';
import { browserRunnerOnline } from '@/lib/visual-audit-runner';
import { assessMissionVisualImpact } from './visual-review-impact-load';
import { uiChangeFromImpact, type VisualImpactAssessment } from './visual-review-impact';
import { resolveVisualReviewPolicy } from './visual-review-policy';
import { planVisualReviewSchedule, type ScheduleAction, type ScheduleAudit } from './visual-review-schedule';
import { getMissionVisualReviewState, loadMissionAuditLedgers } from './visual-review-state-load';
import type { VisualReviewStateInput } from './visual-review-state';

export interface ScheduleOutcome {
  missionId: string;
  plan: ScheduleAction;
  /** The audit task the plan filed or re-stamped. */
  taskId?: string;
}

/** The mission columns the schedule reads. */
const MISSION_COLUMNS = {
  id: missions.id,
  status: missions.status,
  workspaceId: missions.workspaceId,
  executor: missions.executor,
  autoSurfaceAudit: missions.autoSurfaceAudit,
  workingBranch: missions.workingBranch,
  primaryPrNumber: missions.primaryPrNumber,
};

type ScheduleMission = { id: string; status: string; workspaceId: string | null; executor: string | null; autoSurfaceAudit: boolean | null; workingBranch: string | null; primaryPrNumber: number | null };
type ScheduleWorkspace = { id: string; teamId: string; accessMode: string | null; gitConfig: unknown; webhookConfig: { enabled?: unknown; events?: unknown } | null };
type ScheduleDelivery = { id: string; workspaceId: string; prNumber: number | null; state: string; currentHeadSha: string | null; baseRef: string | null };

/**
 * Everything the schedule reads about a batch of missions, read once for the
 * batch (spec 3ef37387 R-25): their workspaces, tasks (context projected),
 * waivers, audit ledgers and integration-PR deliveries. Browser-runner
 * heartbeats are read only when a plan would file, once per workspace.
 */
interface ScheduleFacts {
  workspaces: Map<string, ScheduleWorkspace>;
  tasks: Map<string, SurfaceAuditGateTask[]>;
  waivers: Map<string, SurfaceAuditWaiver>;
  ledgers: Map<string, ScheduleAudit[]>;
  deliveries: Map<string, ScheduleDelivery>;
  /** Browser runner online, per workspace, read at most once per batch. */
  runnerOnline: (workspaceId: string) => Promise<boolean | null>;
  /** The gate's repo links, per workspace, read at most once per batch. */
  repos: Map<string, Promise<{ installationId: number; fullName: string } | null>>;
  /** Review models, read for the whole batch; a mission absent here has none loaded yet. */
  models: Map<string, VisualReviewModel>;
}

const deliveryKey = (workspaceId: string, prNumber: number) => `${workspaceId}:${prNumber}`;

async function loadScheduleFacts(rows: ScheduleMission[], now: number): Promise<ScheduleFacts> {
  const ids = rows.map(m => m.id);
  const wsIds = [...new Set(rows.map(m => m.workspaceId).filter((id): id is string => !!id))];
  const prs = rows.filter(m => m.workspaceId && m.primaryPrNumber != null);
  const [wsRows, taskMap, waivers, ledgers, deliveryRows] = await Promise.all([
    wsIds.length === 0 ? [] : db
      .select({ id: workspaces.id, teamId: workspaces.teamId, accessMode: workspaces.accessMode, gitConfig: workspaces.gitConfig, webhookConfig: workspaces.webhookConfig })
      .from(workspaces)
      .where(inArray(workspaces.id, wsIds)) as Promise<ScheduleWorkspace[]>,
    loadSurfaceAuditGateTasksByMission(ids),
    loadSurfaceAuditWaivers(ids),
    loadMissionAuditLedgers(ids),
    prs.length === 0 ? [] : db
      .select({ id: workflowDeliveries.id, workspaceId: workflowDeliveries.workspaceId, prNumber: workflowDeliveries.prNumber, state: workflowDeliveries.state, currentHeadSha: workflowDeliveries.currentHeadSha, baseRef: workflowDeliveries.baseRef })
      .from(workflowDeliveries)
      .where(and(
        inArray(workflowDeliveries.workspaceId, [...new Set(prs.map(m => m.workspaceId!))]),
        inArray(workflowDeliveries.prNumber, [...new Set(prs.map(m => m.primaryPrNumber!))]),
      )) as Promise<ScheduleDelivery[]>,
  ]);
  const deliveries = new Map<string, ScheduleDelivery>();
  for (const d of deliveryRows) {
    if (d.prNumber == null) continue;
    const key = deliveryKey(d.workspaceId, d.prNumber);
    if (!deliveries.has(key)) deliveries.set(key, d);
  }
  const wsById = new Map(wsRows.map(w => [w.id, w]));
  const online = new Map<string, Promise<boolean | null>>();
  const runnerOnline = (workspaceId: string) => {
    let p = online.get(workspaceId);
    if (!p) {
      const ws = wsById.get(workspaceId);
      p = ws
        ? loadBrowserRunnerHeartbeats(ws, now).catch(() => null).then(hbs => (hbs ? browserRunnerOnline(hbs, workspaceId, now) : null))
        : Promise.resolve(null);
      online.set(workspaceId, p);
    }
    return p;
  };
  return { workspaces: wsById, tasks: taskMap, waivers, ledgers, deliveries, runnerOnline, repos: new Map(), models: new Map() };
}

/** No audit task in the mission: the review model has no audit, which is all the state reads of it then. */
const NO_AUDIT_MODEL = { audit: null } as unknown as VisualReviewModel;

const NO_HOLDS: ReadonlyMap<string, string> = new Map();

/** The UI change, for a state whose plan cannot depend on it (no integration head, or the work has not landed). */
const UI_CHANGE_UNREAD: VisualReviewStateInput['uiChange'] = { state: 'unknown', source: null, uiFiles: 0 };

/**
 * One mission's plan from the batch's facts, then the plan carried out.
 *
 * Reads are skipped only where the plan provably cannot depend on them, so the
 * answer is the one a full read gives (tests/db/visual-review-schedule-plans.test.ts):
 * a policy that files nothing (`off`, `ask`) decides before anything else; with
 * no waiver, work that has not landed or a branch with no known head decides
 * before the review is read; a mission with no audit task has an empty review;
 * and when the classifier will name the UI change anyway, the gate's own read
 * of it is not made.
 */
type Prepared =
  | { done: ScheduleOutcome | null }
  | { done?: undefined; mission: ScheduleMission & { workspaceId: string }; ws: ScheduleWorkspace | null; missionTasks: SurfaceAuditGateTask[]; waiver: SurfaceAuditWaiver | null; ledger: ScheduleAudit[]; d: ScheduleDelivery | null; head: string | null; workLanded: boolean; hasAuditTask: boolean };

/**
 * The part of a mission's plan its batch facts answer alone. Reads are skipped
 * only where the plan provably cannot depend on them, so the answer is the one
 * a full read gives (tests/db/visual-review-schedule-plans.test.ts): a policy
 * that files nothing (`off`, `ask`) decides before anything else, and with no
 * waiver, work that has not landed or a branch with no known head decides
 * before the review is read.
 */
function prepare(mission: ScheduleMission, facts: ScheduleFacts): Prepared {
  if (!mission.workspaceId || mission.status === 'completed' || mission.status === 'archived') return { done: null };
  const missionId = mission.id;
  const ws = facts.workspaces.get(mission.workspaceId) ?? null;
  const policy = resolveVisualReviewPolicy({ workspace: visualReviewPolicyOf(ws?.gitConfig ?? null), mission: { autoSurfaceAudit: mission.autoSurfaceAudit } });
  if (policy.mode === 'off') return { done: { missionId, plan: { action: 'none', why: 'policy_off' } } };
  if (policy.mode === 'ask') return { done: { missionId, plan: { action: 'none', why: 'ask_policy' } } };

  const missionTasks = facts.tasks.get(missionId) ?? [];
  const waiver = facts.waivers.get(missionId) ?? null;
  const ledger = facts.ledgers.get(missionId) ?? [];
  const d = mission.primaryPrNumber != null ? facts.deliveries.get(deliveryKey(mission.workspaceId, mission.primaryPrNumber)) ?? null : null;
  const head = d?.currentHeadSha ?? null;
  const uiBuilders = missionTasks.filter(t => t.taskClass === 'work' && t.roleSlug !== VISUAL_AUDITOR_ROLE_SLUG);
  const workLanded = uiBuilders.length > 0 && uiBuilders.every(t => isTerminalTaskStatus(t.status));

  // Only a waiver can answer before these two (`waived`), and there is none.
  if (!waiver && !workLanded) return { done: { missionId, plan: { action: 'none', why: 'work_not_landed' } } };
  if (!waiver && !head) return { done: { missionId, plan: { action: 'none', why: 'no_integration_head' } } };

  const hasAuditTask = missionTasks.some(t => t.roleSlug === VISUAL_AUDITOR_ROLE_SLUG);
  return { mission: { ...mission, workspaceId: mission.workspaceId }, ws, missionTasks, waiver, ledger, d, head, workLanded, hasAuditTask };
}

/** One mission's plan from the batch's facts, then the plan carried out. */
async function scheduleFromFacts(prepared: Prepared, facts: ScheduleFacts, now: number): Promise<ScheduleOutcome | null> {
  if (prepared.done !== undefined) return prepared.done;
  const { mission, ws, missionTasks, waiver, ledger, d, head, workLanded, hasAuditTask } = prepared;
  const missionId = mission.id;
  const gitConfig = ws?.gitConfig ?? null;

  // A mission with no audit task has an empty review: no audit is all the state reads of it then.
  const model = !hasAuditTask ? NO_AUDIT_MODEL
    : facts.models.get(missionId) ?? (await loadVisualReviews([{ id: missionId, workspaceId: mission.workspaceId }], { runnerOnline: facts.runnerOnline })).get(missionId)!;
  const base = {
    mission: { id: mission.id, status: mission.status, workspaceId: mission.workspaceId, autoSurfaceAudit: mission.autoSurfaceAudit, workingBranch: mission.workingBranch, primaryPrNumber: mission.primaryPrNumber },
    gitConfig,
    tasks: missionTasks,
    ledger,
    waiver: Promise.resolve(waiver),
    model,
    delivery: d ? { state: d.state, currentHeadSha: d.currentHeadSha, baseRef: d.baseRef } : null,
    // The claim loop's hold only words the state for a reader; no plan reads it.
    holdReasons: NO_HOLDS,
    gateRepos: facts.repos,
  };
  const impactFacts = {
    mission: { id: mission.id, workspaceId: mission.workspaceId, autoSurfaceAudit: mission.autoSurfaceAudit, primaryPrNumber: mission.primaryPrNumber },
    workspace: ws ? { teamId: ws.teamId, gitConfig: ws.gitConfig } : null,
    delivery: d ? { id: d.id, currentHeadSha: d.currentHeadSha, baseRef: d.baseRef } : null,
    repoOf: (workspaceId: string) => {
      if (!facts.repos.has(workspaceId)) facts.repos.set(workspaceId, repoFor(workspaceId));
      return facts.repos.get(workspaceId)!;
    },
  };
  const assess = () => assessMissionVisualImpact(missionId, impactFacts).catch(err => {
    console.error('[visual-review-schedule] impact assessment failed (treating as review_required):', err);
    return null;
  });

  // The classifier replaces the file-glob gate as the answer to "does this owe a review" whenever
  // nothing has been filed yet or the pass went stale. Jev is only reached for ambiguous files.
  let impact: VisualImpactAssessment | null = null;
  let state: Awaited<ReturnType<typeof getMissionVisualReviewState>>;
  if (!head || !workLanded) {
    // Waived or not, the plan answers before the UI change matters, and the classifier is not asked.
    state = await getMissionVisualReviewState(missionId, { ...base, uiChange: UI_CHANGE_UNREAD });
  } else if (!waiver && !hasAuditTask) {
    // No audit and no waiver: the state can only be not_applicable, optional or needed,
    // each of which asks the classifier, whose answer replaces the gate's.
    impact = await assess();
    state = impact
      ? await getMissionVisualReviewState(missionId, { ...base, uiChange: uiChangeFromImpact(impact, head) })
      : await getMissionVisualReviewState(missionId, base);
  } else {
    state = await getMissionVisualReviewState(missionId, base);
    if (state && ['optional', 'not_applicable', 'needed'].includes(state.status)) {
      impact = await assess();
      if (impact) state = (await getMissionVisualReviewState(missionId, { ...base, uiChange: uiChangeFromImpact(impact, head) })) ?? state;
    }
  }
  if (!state) return null;

  const planWith = (online: boolean | null) => planVisualReviewSchedule({
    state,
    impact: impact ? { verdict: impact.verdict, headSha: impact.headSha } : null,
    audits: ledger,
    browserRunnerOnline: online,
    executorLocal: mission.executor === 'local',
    now,
  });
  let plan = planWith(null);
  // The runner check only words a filing (`runnerNote`): read it then, once per workspace.
  if (plan.action === 'enqueue' && ws) plan = planWith(await facts.runnerOnline(ws.id));

  if (plan.action === 'restamp') {
    const row = await db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, plan.auditId)), columns: { context: true } });
    const ctx = row?.context && typeof row.context === 'object' && !Array.isArray(row.context) ? row.context as Record<string, unknown> : {};
    // Atomic on status: an audit claimed in the meantime keeps the head it started on.
    await db.update(tasks)
      .set({ context: { ...ctx, visualReview: { headSha: plan.headSha, reason: 'new_head' } }, updatedAt: new Date() })
      .where(and(eq(tasks.id, plan.auditId), eq(tasks.status, 'pending')));
    return { missionId, plan, taskId: plan.auditId };
  }
  if (plan.action === 'enqueue') {
    const res = await requestMissionSurfaceAudit(missionId, {
      headSha: plan.headSha, round: plan.round, reason: plan.reason, attempt: plan.attempt,
      ...(plan.reason === 'recapture' && state.recapture ? { recapture: { screens: state.recapture.screens, routes: state.recapture.routes } } : {}),
      gateTasks: missionTasks, gateRepos: facts.repos, gateWaived: waiver != null,
    });
    return { missionId, plan, ...(res.ok ? { taskId: res.taskId } : {}) };
  }
  return { missionId, plan };
}

export async function scheduleMissionVisualReview(missionId: string, now = Date.now()): Promise<ScheduleOutcome | null> {
  const [mission] = await db.select(MISSION_COLUMNS).from(missions).where(eq(missions.id, missionId)).limit(1) as ScheduleMission[];
  if (!mission || !mission.workspaceId || mission.status === 'completed' || mission.status === 'archived') return null;
  const facts = await loadScheduleFacts([mission], now);
  return scheduleFromFacts(prepare(mission, facts), facts, now);
}

export interface ScheduleSweep {
  outcomes: ScheduleOutcome[];
  /** Where the next run starts: the last mission this one took, or null when it took every candidate. */
  cursor: string | null;
}

/**
 * Open missions with an integration PR; one pass of the scheduler over each.
 * Bounded per run: `limit` missions in id order starting after `after` (the
 * previous run's cursor) and wrapping round, so a fleet with more candidates
 * than the limit is covered over successive runs instead of the same missions
 * every time. With no more candidates than the limit, every run takes them all.
 * `workspaceIds` scopes the sweep (tests).
 */
export async function sweepVisualReviewSchedule(
  now = Date.now(),
  limit = 50,
  opts: { after?: string | null; workspaceIds?: readonly string[] } = {},
): Promise<ScheduleSweep> {
  const after = opts.after && /^[0-9a-f-]{36}$/i.test(opts.after) ? opts.after : null;
  const rows = await db
    .select(MISSION_COLUMNS)
    .from(missions)
    .where(and(
      isNotNull(missions.primaryPrNumber),
      notInArray(missions.status, ['completed', 'archived']),
      opts.workspaceIds ? inArray(missions.workspaceId, [...opts.workspaceIds]) : undefined,
    ))
    .orderBy(...(after ? [sql`(${missions.id} > ${after}::uuid) desc`, missions.id] : [missions.id]))
    .limit(limit) as ScheduleMission[];
  const facts = await loadScheduleFacts(rows, now);
  const prepared = rows.map(r => {
    try { return prepare(r, facts); } catch (err) { console.error(`[visual-review-schedule] mission ${r.id.slice(0, 8)} failed:`, err); return { done: null }; }
  });
  // One read of the review for every mission whose plan needs it.
  const needModel = prepared.flatMap(p => (p.done === undefined && p.hasAuditTask ? [{ id: p.mission.id, workspaceId: p.mission.workspaceId }] : []));
  for (const [id, model] of await loadVisualReviews(needModel, { runnerOnline: facts.runnerOnline })) facts.models.set(id, model);
  const outcomes: ScheduleOutcome[] = [];
  for (const [i, r] of rows.entries()) {
    try {
      const o = await scheduleFromFacts(prepared[i], facts, now);
      if (o) outcomes.push(o);
    } catch (err) {
      console.error(`[visual-review-schedule] mission ${r.id.slice(0, 8)} failed:`, err);
    }
  }
  return { outcomes, cursor: rows.length === limit ? rows[rows.length - 1].id : null };
}
