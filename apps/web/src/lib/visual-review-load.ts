/**
 * The one server-side read of a mission's visual review
 * (docs/design/visual-qa-human-review.md, "Read"). Server-only: every surface
 * that shows audit shots reads them through here, and through
 * `missionVisualShotsWhere` (visual-review-query.ts), so no surface can widen
 * the auditor scoping.
 *
 * Authorization is the caller's: GET /api/missions/[id]/visual-review checks
 * team access before calling `loadVisualReview`.
 */
import 'server-only';
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import type { HumanShotReview, VisualQaVerdict, VisualQaViewport, VisualReviewModel } from '@buildd/shared';
import { SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE } from '@buildd/core/surface-audit';
import { missionIntegrationBase } from '@buildd/core/mission-integration';
import { captureTrunk, resolveVisualQaCaptureRef } from '@buildd/core/visual-qa-capture-ref';
import { loadBrowserRunnerHeartbeats } from '@/lib/runner-heartbeats';
import { auditRequiredRoutes } from '@/lib/visual-qa-required-routes';
import { browserRunnerOnline } from './visual-audit-runner';
import {
  auditAwaitingRunner,
  buildVisualReviewModel,
  type VisualReviewShotRow,
  type VisualReviewTaskInput,
} from './visual-review-model';
import {
  missionCaptureRefQuery,
  missionCaptureRefsQuery,
  roundCapNotesQuery,
  visualReviewTasksForMissionsQuery,
  visualReviewWorkersForMissionsQuery,
  visualShotReviewsForMissionsQuery,
  visualShotsForMissionsQuery,
  roundCapNoteQuery,
  visualReviewTasksQuery,
  visualReviewWorkersQuery,
  visualShotReviewsQuery,
  visualShotsQuery,
  WORKSPACE_AWAITING_MISSIONS_LIMIT,
  workspaceAwaitingMissionsQuery,
} from './visual-review-query';

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : typeof d === 'string' ? d : d.toISOString();

/**
 * The mission's audit shot rows (auditor-scoped, newest first, each with its
 * worker's task). For the pages that still build the adapter
 * (`missionVisualReview`) from rows.
 */
export async function loadMissionVisualShotRows(missionId: string): Promise<VisualReviewShotRow[]> {
  const rows = await visualShotsQuery(db, missionId) as Array<VisualReviewShotRow & { createdAt: Date | string }>;
  return rows;
}

type ReviewRow = {
  id: string;
  artifactId: string;
  auditTaskId: string | null;
  round: number;
  cellKey: string;
  route: string;
  viewport: string;
  agentVerdict: string;
  decision: string;
  relation: string;
  note: string | null;
  fixTaskId: string | null;
  cancelledFixTaskId: string | null;
  reviewerUserId: string | null;
  reviewerLabel: string | null;
  supersededAt: Date | string | null;
  createdAt: Date | string;
};

export function toHumanShotReview(r: ReviewRow): HumanShotReview {
  return {
    id: r.id,
    artifactId: r.artifactId,
    auditTaskId: r.auditTaskId,
    round: r.round,
    cellKey: r.cellKey,
    route: r.route,
    viewport: r.viewport as VisualQaViewport,
    agentVerdict: r.agentVerdict as VisualQaVerdict,
    decision: r.decision as HumanShotReview['decision'],
    relation: r.relation as HumanShotReview['relation'],
    note: r.note,
    fixTaskId: r.fixTaskId,
    cancelledFixTaskId: r.cancelledFixTaskId,
    reviewerUserId: r.reviewerUserId,
    reviewerLabel: r.reviewerLabel,
    createdAt: iso(r.createdAt)!,
    supersededAt: iso(r.supersededAt),
  };
}

type TaskRow = VisualReviewTaskInput & { pathManifest?: unknown };
type CaptureRefRow = {
  workingBranch: string | null;
  integrationBranchEnabled: boolean | null;
  gitConfig: { targetBranch?: string; defaultBranch?: string } | null;
};
type WorkerRow = NonNullable<VisualReviewTaskInput['workers']>[number] & { taskId: string | null };

/**
 * The mission's `VisualReviewModel`: shots, tasks, their workers, reviews and
 * the round-cap question in parallel; browser-runner heartbeats only when a
 * claimable audit has waited past the window.
 */
export async function loadVisualReview(
  mission: { id: string; workspaceId: string | null },
  opts: { now?: number } = {},
): Promise<VisualReviewModel> {
  const now = opts.now ?? Date.now();
  const [shotRows, taskRows, workerRows, reviewRows, capRows, refRows] = await Promise.all([
    visualShotsQuery(db, mission.id) as Promise<VisualReviewShotRow[]>,
    visualReviewTasksQuery(db, mission.id) as Promise<TaskRow[]>,
    visualReviewWorkersQuery(db, mission.id) as Promise<WorkerRow[]>,
    visualShotReviewsQuery(db, mission.id) as Promise<ReviewRow[]>,
    roundCapNoteQuery(db, mission.id, SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE) as Promise<Array<{ id: string }>>,
    missionCaptureRefQuery(db, mission.id) as Promise<CaptureRefRow[]>,
  ]);
  return modelFromRows(mission, { shotRows, taskRows, workerRows, reviewRows, capOpen: capRows.length > 0, refRow: refRows[0] }, now, async workspaceId => {
    const [ws] = await db
      .select({ id: workspaces.id, teamId: workspaces.teamId, accessMode: workspaces.accessMode, gitConfig: workspaces.gitConfig, webhookConfig: workspaces.webhookConfig })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1) as Array<{ id: string; teamId: string; accessMode: string | null; gitConfig: { executor?: unknown } | null; webhookConfig: { enabled?: unknown; events?: unknown } | null }>;
    const hbs = ws ? await loadBrowserRunnerHeartbeats(ws, now) : null;
    return hbs ? browserRunnerOnline(hbs, workspaceId, now) : null;
  });
}

interface MissionReviewRows {
  shotRows: VisualReviewShotRow[];
  taskRows: TaskRow[];
  workerRows: WorkerRow[];
  reviewRows: ReviewRow[];
  capOpen: boolean;
  refRow: CaptureRefRow | undefined;
}

/** One mission's model from its rows: the part `loadVisualReview` and `loadVisualReviews` share. */
async function modelFromRows(
  mission: { id: string; workspaceId: string | null },
  rows: MissionReviewRows,
  now: number,
  runnerOnlineOf: (workspaceId: string) => Promise<boolean | null>,
): Promise<VisualReviewModel> {
  const { shotRows, taskRows, workerRows, reviewRows, capOpen, refRow } = rows;
  // No live branch check here (no GitHub call on a read): a trunk shot taken
  // because the branch was gone records refSource integration_missing, and
  // captureRefMatch never calls that one wrong.
  const captureRef = refRow
    ? resolveVisualQaCaptureRef({ mission: refRow, trunk: captureTrunk(refRow.gitConfig) }).ref
    : null;
  const missionIntegrationBranch = refRow ? missionIntegrationBase(refRow) : null;

  const workersByTask = new Map<string, WorkerRow[]>();
  for (const w of workerRows) {
    if (!w.taskId) continue;
    workersByTask.set(w.taskId, [...(workersByTask.get(w.taskId) ?? []), w]);
  }
  const tasks: TaskRow[] = taskRows.map(t => ({ ...t, workers: workersByTask.get(t.id) ?? [] }));
  const byId = new Map(tasks.map(t => [t.id, t]));

  let runnerOnline: boolean | null = null;
  if (mission.workspaceId && auditAwaitingRunner(tasks, now)) runnerOnline = await runnerOnlineOf(mission.workspaceId);

  return buildVisualReviewModel({
    missionId: mission.id,
    shots: shotRows,
    tasks,
    reviews: reviewRows.map(toHumanShotReview),
    roundCapOpen: capOpen,
    browserRunnerOnline: runnerOnline,
    requiredRoutesOf: t => auditRequiredRoutes(
      { context: t.context },
      (t.dependsOn ?? []).map(d => byId.get(d) as TaskRow | undefined),
    ),
    captureRef,
    missionIntegrationBranch,
    now,
  });
}

/**
 * `loadVisualReview` for a batch of missions (the visual-review scheduler's
 * sweep, spec 3ef37387 R-25): six queries for the whole batch instead of six
 * per mission, each mission's model built from its own rows exactly as
 * `loadVisualReview` builds it. `runnerOnline` answers the browser-runner
 * question per workspace when an audit has waited past the window (the
 * caller memoises it across the batch).
 */
export async function loadVisualReviews(
  missionList: ReadonlyArray<{ id: string; workspaceId: string | null }>,
  opts: { now?: number; runnerOnline: (workspaceId: string) => Promise<boolean | null> },
): Promise<Map<string, VisualReviewModel>> {
  const out = new Map<string, VisualReviewModel>();
  if (missionList.length === 0) return out;
  const now = opts.now ?? Date.now();
  const ids = missionList.map(m => m.id);
  const [shotRows, taskRows, workerRows, reviewRows, capRows, refRows] = await Promise.all([
    visualShotsForMissionsQuery(db, ids) as Promise<Array<VisualReviewShotRow & { missionId: string | null }>>,
    visualReviewTasksForMissionsQuery(db, ids) as Promise<Array<TaskRow & { missionId: string | null }>>,
    visualReviewWorkersForMissionsQuery(db, ids) as Promise<WorkerRow[]>,
    visualShotReviewsForMissionsQuery(db, ids) as Promise<Array<ReviewRow & { missionId: string | null }>>,
    roundCapNotesQuery(db, ids, SURFACE_AUDIT_ROUND_CAP_NOTE_TITLE) as Promise<Array<{ missionId: string | null }>>,
    missionCaptureRefsQuery(db, ids) as Promise<Array<CaptureRefRow & { missionId: string }>>,
  ]);
  const group = <T extends { missionId?: string | null }>(rows: T[]) => {
    const by = new Map<string, T[]>();
    for (const r of rows) {
      if (!r.missionId) continue;
      const list = by.get(r.missionId) ?? [];
      list.push(r);
      by.set(r.missionId, list);
    }
    return by;
  };
  const shots = group(shotRows);
  const tasksBy = group(taskRows);
  const reviews = group(reviewRows);
  const capOpen = new Set(capRows.map(r => r.missionId).filter(Boolean));
  const refs = new Map(refRows.map(r => [r.missionId, r]));
  const missionOfTask = new Map(taskRows.map(t => [t.id, t.missionId]));
  const workersBy = new Map<string, WorkerRow[]>();
  for (const w of workerRows) {
    const m = w.taskId ? missionOfTask.get(w.taskId) : null;
    if (!m) continue;
    workersBy.set(m, [...(workersBy.get(m) ?? []), w]);
  }
  for (const mission of missionList) {
    out.set(mission.id, await modelFromRows(mission, {
      shotRows: shots.get(mission.id) ?? [],
      taskRows: tasksBy.get(mission.id) ?? [],
      workerRows: workersBy.get(mission.id) ?? [],
      reviewRows: reviews.get(mission.id) ?? [],
      capOpen: capOpen.has(mission.id),
      refRow: refs.get(mission.id),
    }, now, opts.runnerOnline));
  }
  return out;
}

export interface WorkspaceAwaitingMission {
  id: string;
  title: string;
  status: string;
  phase: VisualReviewModel['phase'];
  /** Why it waits on a human (`needsYou.reason`): unsure screens, the round cap, or a question. */
  reason: 'unsure' | 'round_cap' | 'question' | 'fix_check';
  /** Current screens the agent was unsure about that no human has decided. */
  awaitingHuman: number;
}

/**
 * A workspace's missions waiting on a human (unsure screens, the round cap or
 * a question), each with its reason and exact count from its own model. Candidates come from
 * `workspaceAwaitingMissionsQuery` (newest first, the caller's teams only);
 * `more` says candidates past the limit were not checked.
 *
 * Authorization is the caller's: GET /api/workspaces/[id]/visual-review.
 */
export async function loadWorkspaceAwaitingReview(
  workspaceId: string,
  teamIds: readonly string[],
  opts: { now?: number } = {},
): Promise<{ missions: WorkspaceAwaitingMission[]; more: boolean }> {
  if (teamIds.length === 0) return { missions: [], more: false };
  const rows = await workspaceAwaitingMissionsQuery(db, workspaceId, teamIds) as Array<{ id: string; title: string; status: string; workspaceId: string | null }>;
  const more = rows.length > WORKSPACE_AWAITING_MISSIONS_LIMIT;
  const candidates = rows.slice(0, WORKSPACE_AWAITING_MISSIONS_LIMIT);
  const models = await Promise.all(candidates.map(m => loadVisualReview({ id: m.id, workspaceId: m.workspaceId }, opts)));
  const missions: WorkspaceAwaitingMission[] = [];
  candidates.forEach((m, i) => {
    const { phase, needsYou, summary } = models[i];
    const reason = needsYou?.reason ?? (summary.awaitingHuman > 0 ? 'unsure' : null);
    if (!reason || (phase !== 'needs_you' && summary.awaitingHuman === 0)) return;
    missions.push({ id: m.id, title: m.title, status: m.status, phase, reason, awaitingHuman: summary.awaitingHuman });
  });
  return { missions, more };
}
