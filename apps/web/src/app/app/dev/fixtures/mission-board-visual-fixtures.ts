/**
 * The `?state=mission-board-visual` dev fixture: the real MissionBoard,
 * MissionLanes and MissionFeedLayout with a visual review model, so the
 * mission-page wiring (docs/design/visual-qa-human-review.md, "Where it
 * shows") can be seen and screenshotted with no database.
 *
 *   ?state=mission-board-visual&phase=<phase>     the Board with the audit in that phase
 *   &reason=unsure|question|round_cap              which needs_you
 *   &layout=board|lanes|feed                       which mission layout
 *   &complete=1                                    the mission is done (completion record)
 *
 * The board is illustrative: a small mission whose last task is the audit
 * the visual model describes, so the Tray sits under that task's tile.
 * Decisions go to the in-memory fixture transport, never the network.
 */
import { VISUAL_REVIEW_PHASES, type VisualReviewModel, type VisualReviewNeedsYouReason, type VisualReviewPhase } from '@buildd/shared';
import { buildMissionBoard, type BoardTaskInput, type BoardWorkerInput, type MissionBoardModel } from '@/lib/mission-board';
import { VISUAL_AUDITOR_ROLE_SLUG } from '@/lib/mission-visual-review';
import type { VisualReviewFixtureOptions } from '@/lib/visual-review-model.fixtures';
import { MISSION_BOARD_VISUAL_FIXTURE_STATE } from './visual-review-fixtures';

export const MISSION_BOARD_VISUAL_STATE = MISSION_BOARD_VISUAL_FIXTURE_STATE;
export const MISSION_BOARD_VISUAL_LAYOUTS = ['board', 'lanes', 'feed'] as const;
export type MissionBoardVisualLayout = (typeof MISSION_BOARD_VISUAL_LAYOUTS)[number];

const REASONS: readonly VisualReviewNeedsYouReason[] = ['unsure', 'question', 'round_cap'];

export interface MissionBoardVisualParams {
  phase: VisualReviewPhase;
  options: VisualReviewFixtureOptions;
  layout: MissionBoardVisualLayout;
  complete: boolean;
}

/** Pure: the query to what the page renders. Unknown values fall back. */
export function parseMissionBoardVisualParams(q: URLSearchParams): MissionBoardVisualParams {
  const phaseParam = q.get('phase');
  const phase = (VISUAL_REVIEW_PHASES as readonly string[]).includes(phaseParam ?? '') && phaseParam !== 'off'
    ? (phaseParam as VisualReviewPhase)
    : 'needs_you';
  const layoutParam = q.get('layout');
  const layout = (MISSION_BOARD_VISUAL_LAYOUTS as readonly string[]).includes(layoutParam ?? '') ? (layoutParam as MissionBoardVisualLayout) : 'board';
  const reasonParam = q.get('reason');
  const options: VisualReviewFixtureOptions = {};
  if (phase === 'needs_you') {
    options.needsYou = (REASONS as readonly string[]).includes(reasonParam ?? '') ? (reasonParam as VisualReviewNeedsYouReason) : 'unsure';
    if (options.needsYou === 'unsure') options.scenario = 'deck';
  }
  return { phase, options, layout, complete: q.get('complete') === '1' };
}

export function missionBoardVisualLinks(): { label: string; href: string }[] {
  const base = `?state=${MISSION_BOARD_VISUAL_STATE}`;
  return [
    ...VISUAL_REVIEW_PHASES.filter(p => p !== 'off' && p !== 'needs_you').map(p => ({ label: p, href: `${base}&phase=${p}` })),
    ...REASONS.map(r => ({ label: `needs_you: ${r}`, href: `${base}&phase=needs_you&reason=${r}` })),
    { label: 'complete', href: `${base}&phase=reviewed&complete=1` },
    { label: 'lanes', href: `${base}&phase=needs_you&layout=lanes` },
    { label: 'feed', href: `${base}&phase=needs_you&layout=feed` },
  ];
}

// ── The board ───────────────────────────────────────────────────────────────

export const MISSION_BOARD_VISUAL_T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
// The fixture's clock origin; `missionBoardVisualFixture({ t0 })` moves it so
// a live page reads "12m", not the months since a fixed date.
let T0 = MISSION_BOARD_VISUAL_T0;
const min = (n: number) => T0 + n * 60_000;

function worker(id: string, over: Partial<BoardWorkerInput>): BoardWorkerInput {
  return {
    id, status: 'completed', runner: 'alpha', startedAt: min(1), completedAt: min(8), updatedAt: min(8),
    mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, waitingFor: null,
    milestones: [], linesAdded: null, linesRemoved: null, ...over,
  };
}

function task(id: string, phase: 1 | 2, order: number, over: Partial<BoardTaskInput>): BoardTaskInput {
  const workers = over.workers ?? [];
  const first = workers[0];
  return {
    id, title: `feat(${id}): example ${id} work`, status: 'completed', taskClass: 'work',
    createdAt: new Date(T0 + order * 1000),
    missionPhaseIndex: phase, missionPhaseLabel: phase === 1 ? 'Build the screens' : 'Check them',
    roleSlug: 'builder', outputRequirement: 'pr_required', workers,
    worker: first ? {
      status: first.status, startedAt: first.startedAt ? new Date(first.startedAt) : null,
      updatedAt: first.updatedAt ? new Date(first.updatedAt) : null, prNumber: first.prNumber,
      prUrl: first.prUrl, prLifecycleStatus: first.prLifecycleStatus, mergedAt: first.mergedAt ? new Date(first.mergedAt) : null,
    } : null,
    ...over,
  };
}

/** The audit task as the board sees it, from the visual model's latest audit. */
function auditTask(visual: VisualReviewModel, complete: boolean): BoardTaskInput {
  const a = visual.audit!;
  const prompt = visual.bootFailure?.prompt ?? (visual.needsYou?.reason === 'question' ? visual.needsYou.prompt : undefined);
  const status = complete ? 'completed' : prompt ? 'in_progress' : a.status;
  const w = (() => {
    if (complete || status === 'completed') return [worker('fixture-audit-worker', { runner: 'gamma', startedAt: min(20), completedAt: min(34), updatedAt: min(34) })];
    if (prompt) {
      return [worker('fixture-audit-worker', {
        runner: 'gamma', status: 'waiting_input', startedAt: min(20), completedAt: null, updatedAt: min(24),
        waitingFor: { prompt, options: visual.bootFailure ? ['I fixed it, try again', 'Skip the visual audit'] : ['Use the demo account'] },
      })];
    }
    if (status === 'in_progress' || status === 'assigned') {
      return [worker('fixture-audit-worker', {
        runner: 'gamma', status: 'running', startedAt: min(20), completedAt: null, updatedAt: min(26),
        currentAction: 'Shooting /app/tasks/:id on a phone',
      })];
    }
    if (status === 'failed') return [worker('fixture-audit-worker', { runner: 'gamma', status: 'failed', startedAt: min(20), completedAt: null, updatedAt: min(30) })];
    return [];
  })();
  return task(a.id, 2, 10, {
    title: a.title || '[surface audit] Fixture mission',
    label: 'visual audit',
    roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
    outputRequirement: 'none',
    status: status === 'waiting_input' ? 'in_progress' : status,
    dependsOn: ['screens', 'layout'],
    workers: w,
  });
}

/**
 * A small mission around `visual`'s latest audit: two landed build tasks, a
 * third still running (unless complete), and the audit in phase 2.
 */
export function missionBoardVisualFixture(visual: VisualReviewModel, opts: { complete?: boolean; t0?: number } = {}): MissionBoardModel {
  const complete = opts.complete === true;
  T0 = opts.t0 ?? MISSION_BOARD_VISUAL_T0;
  const tasks: BoardTaskInput[] = [
    task('screens', 1, 1, { workers: [worker('fixture-w-screens', { prNumber: 11, prUrl: 'https://example.test/pulls/11', mergedAt: min(9), linesAdded: 120, linesRemoved: 8 })] }),
    task('layout', 1, 2, { workers: [worker('fixture-w-layout', { runner: 'beta', startedAt: min(3), completedAt: min(14), updatedAt: min(14), prNumber: 12, prUrl: 'https://example.test/pulls/12', mergedAt: min(15), linesAdded: 64, linesRemoved: 20 })] }),
    task('copy', 2, 3, complete
      ? { workers: [worker('fixture-w-copy', { runner: 'beta', startedAt: min(16), completedAt: min(22), updatedAt: min(22), prNumber: 13, prUrl: 'https://example.test/pulls/13', mergedAt: min(23), linesAdded: 12, linesRemoved: 4 })] }
      : { status: 'in_progress', workers: [worker('fixture-w-copy', { runner: 'beta', status: 'running', startedAt: min(16), completedAt: null, updatedAt: min(27), currentAction: 'Rewording the empty states' })] }),
    ...(visual.audit ? [auditTask(visual, complete)] : []),
  ];
  return buildMissionBoard({
    tasks,
    roles: [
      { slug: 'builder', name: 'Builder', color: 'var(--status-info)' },
      { slug: VISUAL_AUDITOR_ROLE_SLUG, name: 'Visual auditor', color: 'var(--status-success)' },
    ],
    now: complete ? min(60) : min(30),
    missionCreatedAt: T0,
    missionCompletedAt: complete ? min(40) : null,
    missionStatus: complete ? 'completed' : 'active',
    criteria: [{ type: 'all_prs_merged' }, { type: 'no_open_tasks' }],
    criteriaState: complete ? [{ index: 0, verdict: 'pass' }, { index: 1, verdict: 'pass' }] : [],
    humanTouches: complete ? [min(36)] : [],
  });
}
