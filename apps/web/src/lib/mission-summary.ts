/**
 * A mission's summary: the one answer list surfaces show for it (spec
 * 3ef37387 R-13, R-24; the state's meaning is spec 8e137fdb's). Pure.
 *
 * It is not a sixth derivation. It runs the ones the surfaces already run,
 * on one mission's rows:
 *   - stage and progress cells: `assembleMissionStages` (the rail's
 *     `missionStage` and the Overview strip's `taskRowsProgress`), as
 *     `GET /api/missions/stages` sends them;
 *   - progress, health, health signal, state kind and group:
 *     `summarizeMissionForCard`, as Home and the missions list build a card;
 *   - delivery: `deriveMissionIntegrationPr`, else the newest deliverable PR;
 *   - last activity: the missions list's `recent` order
 *     (`missionListOrderBy`).
 *
 * What the list readings cannot know they leave out here too: no visual
 * review state, no deploy baseline, no escalation-gate verdict. The store
 * (lib/mission-summary-store.ts) writes the output; the loader
 * (lib/mission-summary-load.ts) reads the input.
 */
import { MISSION_SUMMARY_VERSION, type MissionSummary, type MissionSummaryDelivery } from '@buildd/shared';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import { assembleMissionStages, type MissionStageRows } from './mission-stage-assemble';
import { summarizeMissionForCard, type MissionCardRow } from './mission-card-view';
import { missionNeedsYou } from './mission-state-view';
import { deriveMissionIntegrationPr } from './mission-integration-pr';
import { overlayDeliveryLifecycle } from './delivery-overlay';

/** One mission's rows, as `loadMissionSummaryInputs` reads them. */
export interface MissionSummaryInput extends MissionStageRows {
  /** Workers in `LIVE_WORKER_STATUSES` on the mission's tasks: an exact count, not the loaded rows. */
  liveWorkers: number;
}

type Row = Record<string, any>;

const ms = (d: unknown): number => {
  if (d == null) return Number.NaN;
  return new Date(d as string | Date).getTime();
};

/** Newest first, as the card's and the page's queries order workers (`startedAt DESC`, never-started first). */
function newestFirst(ws: Row[]): Row[] {
  const key = (w: Row) => (w.startedAt == null ? Number.POSITIVE_INFINITY : ms(w.startedAt));
  return ws.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    if (x !== y) return x > y ? -1 : 1;
    const u = ms(a.updatedAt) || 0, v = ms(b.updatedAt) || 0;
    return v - u;
  });
}

function prState(w: Row): MissionSummaryDelivery['state'] {
  if (w.mergedAt || w.prLifecycleStatus === 'merged') return 'merged';
  if (w.prLifecycleStatus === 'closed') return 'closed';
  return 'open';
}

/**
 * The mission PR when the mission has an integration branch. Else the PR a
 * deliverable task still has open (the newest, if several), and failing that
 * the newest one it shipped or closed.
 */
function currentDelivery(mission: Row, tasks: Row[]): MissionSummaryDelivery | null {
  const missionPr = deriveMissionIntegrationPr({ mission: mission as never, tasks: tasks as never });
  if (missionPr) return { source: 'mission_pr', prNumber: missionPr.prNumber, prUrl: missionPr.prUrl, state: missionPr.state };
  let best: { w: Row; open: boolean; at: number } | null = null;
  for (const t of tasks) {
    if (t.status === 'cancelled' || !isDeliverableTask(t as never)) continue;
    for (const w of t.workers ?? []) {
      if (!w.prUrl) continue;
      const open = prState(w) === 'open';
      const at = Math.max(ms(w.updatedAt) || 0, ms(w.startedAt) || 0);
      if (!best || (open && !best.open) || (open === best.open && at > best.at)) best = { w, open, at };
    }
  }
  if (!best) return null;
  return { source: 'task_pr', prNumber: best.w.prNumber ?? null, prUrl: best.w.prUrl ?? null, state: prState(best.w) };
}

/** `missionListOrderBy('recent')`: the latest task start or task update, else the mission's own update. */
function lastActivity(mission: Row, tasks: Row[]): string | null {
  let latest = Number.NaN;
  const consider = (d: unknown) => {
    const t = ms(d);
    if (!Number.isNaN(t) && (Number.isNaN(latest) || t > latest)) latest = t;
  };
  consider(mission.lastTaskStartedAt);
  for (const t of tasks) consider(t.updatedAt);
  if (Number.isNaN(latest)) consider(mission.updatedAt);
  return Number.isNaN(latest) ? null : new Date(latest).toISOString();
}

/**
 * The summary of the one mission in `input`. `now` is the clock the
 * time-dependent readings use; the store passes the time it read the rows.
 */
export function computeMissionSummary(input: MissionSummaryInput, now: number): MissionSummary {
  const mission = input.missionRows[0] as Row | undefined;
  if (!mission) throw new Error('computeMissionSummary: no mission row');
  const taskRows = input.taskRows as unknown as Row[];

  // The stage reads the projected context it always read (mission-stage-sql.ts), never the card digest.
  const stageTasks = taskRows.map(({ context: _digest, ...t }) => t) as unknown as MissionStageRows['taskRows'];
  const stage = assembleMissionStages({ ...input, taskRows: stageTasks }).get(mission.id)
    ?? { step: 'planning' as const, waitingOn: null, progress: [] };

  // The card's tasks: each with its workers newest first, the kernel's delivery reading laid over them.
  const workersByTask = new Map<string, Row[]>();
  for (const w of input.workerRows as unknown as Row[]) {
    if (!w.taskId) continue;
    const list = workersByTask.get(w.taskId) ?? [];
    list.push(w);
    workersByTask.set(w.taskId, list);
  }
  const deliveryViews = input.deliveryViews as Map<string, any>;
  const cardTasks = overlayDeliveryLifecycle(
    taskRows.map(t => ({ ...t, workers: newestFirst(workersByTask.get(t.id) ?? []) })) as any[],
    deliveryViews,
  ) as Row[];
  const card = summarizeMissionForCard({ ...mission, tasks: cardTasks } as MissionCardRow, {
    now, liveWorkers: input.liveWorkers, deliveryViews,
  });

  const taskCounts: Record<string, number> = {};
  for (const t of taskRows) taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;

  return {
    v: MISSION_SUMMARY_VERSION,
    stage,
    progress: { done: card.completedTasks, total: card.totalTasks, percent: card.progress },
    health: card.health,
    healthSignal: card.healthState,
    stateKind: card.state.kind,
    needsYou: missionNeedsYou(card.state),
    group: card.group,
    liveWorkers: card.liveWorkers,
    hasPendingDeliverableWork: card.hasPendingDeliverableWork,
    taskCounts: sortedKeys(taskCounts),
    delivery: currentDelivery(mission, cardTasks),
    lastActivityAt: lastActivity(mission, taskRows),
  };
}

function sortedKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
}

/**
 * Key-order-independent JSON, so a stored summary (jsonb reorders keys)
 * compares equal to the same summary computed again.
 */
export function canonicalSummaryJson(value: unknown): string {
  return JSON.stringify(canon(value));
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.keys(v as object).sort()
      .filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .map(k => [k, canon((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** Same summary? Compared as canonical JSON. */
export function summariesEqual(a: MissionSummary | null | undefined, b: MissionSummary | null | undefined): boolean {
  if (!a || !b) return a === b;
  return canonicalSummaryJson(a) === canonicalSummaryJson(b);
}
