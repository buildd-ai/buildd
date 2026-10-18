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
 *   - Home's reading (`home`): the delivery projection (`projectMissionDelivery`
 *     with `missionDeliveryFacts`), its quiet cause, and the list card's kind,
 *     held, done and strand facts (`buildMissionListCard`), as Home built them;
 *   - the missions list's reading (`list`): the row's strip
 *     (`taskRowsStripProjection`, as the mission page draws it), its last
 *     advance and a recurring mission's next run;
 *   - the visual review state, when the loader read it (an open audit or fix,
 *     or an open mission PR), for the card's delivery line and the mission PR
 *     gate, so no page reads it (or GitHub) while it renders.
 *
 * What the list readings cannot know they leave out here too: no deploy
 * baseline, no escalation-gate verdict. The store
 * (lib/mission-summary-store.ts) writes the output; the loader
 * (lib/mission-summary-load.ts) reads the input.
 */
import { MISSION_SUMMARY_VERSION, type MissionSummary, type MissionSummaryDelivery, type MissionSummaryHome, type MissionSummaryList } from '@buildd/shared';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import { assembleMissionStages, type MissionStageRows } from './mission-stage-assemble';
import { buildMissionCardView, summarizeMissionForCard, type MissionCardRow, type MissionCardSummary } from './mission-card-view';
import { buildMissionListCard, type ListMissionRow, type StrandCta } from './mission-list-card';
import { projectMissionDelivery, quietCauseOf, toDeliveryRow, type MissionDeliveryRow } from './delivery-projection';
import { missionDeliveryFacts } from './mission-delivery-facts';
import { summarizeVisualReview } from './mission-open-checks';
import type { MissionVisualReviewState } from './workflow/visual-review-state';
import { missionWorkHolder, missionWorkStateFromRows } from './mission-work-state';
import { missionNeedsYou } from './mission-state-view';
import { deriveMissionIntegrationPr } from './mission-integration-pr';
import { prOutcome } from './pr-presentation';
import { overlayDeliveryLifecycle } from './delivery-overlay';
import { taskRowsStripProjection } from './mission-strip-order';

/** One mission's rows, as `loadMissionSummaryInputs` reads them. */
export interface MissionSummaryInput extends MissionStageRows {
  /** Workers in `LIVE_WORKER_STATUSES` on the mission's tasks: an exact count, not the loaded rows. */
  liveWorkers: number;
  /** The visual review state, when the loader read it (`summaryReadsVisualReview`); absent or null otherwise. */
  visualReview?: MissionVisualReviewState | null;
  /** The escalation gate's stored verdict on the mission's own PR, when one exists. */
  escalationGateVerdict?: { owner: 'person' | 'machine'; reason?: string | null } | null;
}

/** Home's reading with its precise types (the stored JSON is `MissionSummaryHome`). */
export interface MissionHomeReading extends MissionSummaryHome {
  delivery: MissionDeliveryRow;
  card: MissionSummaryHome['card'] & { strand: StrandCta | null };
}

export const homeReadingOf = (s: Pick<MissionSummary, 'home'>): MissionHomeReading => s.home as MissionHomeReading;

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
  return prOutcome(w);
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

  const visualReview = input.visualReview ?? null;
  const visualRead = input.visualReview !== undefined;
  // Home's card reads the visual review and the mission PR's stored verdict too; the list fields above do not.
  const verdict = input.escalationGateVerdict ?? null;
  const homeCard = visualRead || verdict
    ? summarizeMissionForCard({ ...mission, escalationGateVerdict: verdict, tasks: cardTasks } as MissionCardRow, {
        now, liveWorkers: input.liveWorkers, deliveryViews, visualReview: visualRead ? summarizeVisualReview(visualReview) : null,
      })
    : card;
  const home = homeReading(mission, cardTasks, homeCard, deliveryViews, visualReview, visualRead, now);

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
    home,
    list: listReading(mission, cardTasks, card, input.deliveries as ReadonlyMap<string, unknown>),
    visualReview: visualReview as unknown as Record<string, unknown> | null,
    missionPrWorkHolder: mission.integrationBranchEnabled === true && mission.status !== 'completed' && mission.status !== 'archived'
      ? missionWorkHolder(missionWorkStateFromRows(mission, taskRows as never, input.workerRows as never))
      : null,
  };
}

/** Recurring, live or held: the missions Home lists (lib/mission-list-card.ts kinds, Home's rule). */
const LIVE_GROUPS: ReadonlySet<string> = new Set(['running', 'attention', 'review']);

/**
 * Home's reading of one mission, from the card's overlaid rows: the same
 * builders Home ran on its own loaded rows (`projectMissionDelivery`,
 * `buildMissionCardView`, `buildMissionListCard`).
 */
function homeReading(
  mission: Row, cardTasks: Row[], card: MissionCardSummary, deliveryViews: Map<string, any>,
  visualReview: MissionVisualReviewState | null, visualRead: boolean, now: number,
): MissionHomeReading {
  const row = { ...mission, tasks: cardTasks } as unknown as ListMissionRow;
  const delivery = projectMissionDelivery({
    id: mission.id, title: mission.title, status: mission.status, href: `/app/missions/${mission.id}`,
    isHeld: mission.isHeld, armedAt: mission.armedAt, integrationBranch: mission.integrationBranchEnabled === true,
    tasks: cardTasks as never,
    // The same facts the missions list reads, so both cards agree.
    ...missionDeliveryFacts(row as never, visualRead ? summarizeVisualReview(visualReview) : undefined, now),
  }, missionHelpers);
  const view = buildMissionCardView(row, { from: 'home', now, summary: card, deliveryViews });
  const model = buildMissionListCard(row, view, card, { now });
  const live = card.liveWorkers > 0 || LIVE_GROUPS.has(card.group);
  return {
    delivery: toDeliveryRow(delivery),
    quietCause: quietCauseOf(delivery),
    card: {
      kind: model.kind,
      listed: model.kind === 'recurring' || live || !!mission.isHeld,
      done: model.counts.done,
      total: model.counts.total,
      donePrs: model.done?.prs ?? null,
      held: model.held,
      strand: model.strand,
    },
  };
}

/**
 * The missions list's reading of one mission: the strip's cells in the
 * mission page's dependency-first order (each task with its kernel delivery
 * display, as the page passes it), the latest task movement, and when a
 * recurring mission runs next (a check-in schedule is not recurring work).
 */
function listReading(mission: Row, cardTasks: Row[], card: MissionCardSummary, deliveries: ReadonlyMap<string, unknown>): MissionSummaryList {
  const projection = taskRowsStripProjection(cardTasks.map(t => ({ ...t, delivery: deliveries.get(t.id) ?? null })) as never);
  let advanced = ms(mission.lastTaskStartedAt) || 0;
  for (const t of cardTasks) advanced = Math.max(advanced, ms(t.updatedAt) || 0);
  const schedule = mission.schedule as { cronExpression?: string | null; taskTemplate?: { context?: { heartbeat?: unknown } } | null } | null;
  const recurring = !!schedule?.cronExpression && schedule.taskTemplate?.context?.heartbeat !== true && mission.status !== 'completed';
  return {
    strip: projection.order.flatMap(id => projection.states.get(id) ?? []),
    lastAdvancedAt: advanced > 0 ? new Date(advanced).toISOString() : null,
    nextRunAt: recurring ? card.nextRunAt : null,
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
