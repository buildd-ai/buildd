/**
 * Illustrative mission Board fixtures for component tests — no real mission,
 * task or runner data. One mission at three moments: mid-flight, with a
 * question open, and complete.
 */
import { buildMissionBoard, type BoardTaskInput, type BoardWorkerInput, type MissionBoardModel } from './mission-board';

export const BOARD_T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const min = (n: number) => BOARD_T0 + n * 60_000;

let seq = 0;
function w(over: Partial<BoardWorkerInput>): BoardWorkerInput {
  seq += 1;
  return {
    id: `worker-${seq}`, status: 'running', runner: 'alpha', startedAt: min(1), completedAt: null, updatedAt: min(2),
    mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, waitingFor: null,
    milestones: [], linesAdded: null, linesRemoved: null, ...over,
  };
}

function t(id: string, phase: 1 | 2, over: Partial<BoardTaskInput>): BoardTaskInput {
  const workers = over.workers ?? [];
  const first = workers[0];
  return {
    id, title: `feat(${id}): example ${id} work`, status: 'pending', taskClass: 'work',
    createdAt: new Date(BOARD_T0 + seq++ * 1000),
    missionPhaseIndex: phase, missionPhaseLabel: phase === 1 ? 'Groundwork' : 'Finish',
    roleSlug: 'builder', outputRequirement: 'pr_required', workers,
    worker: first ? {
      status: first.status, startedAt: first.startedAt ? new Date(first.startedAt) : null,
      updatedAt: first.updatedAt ? new Date(first.updatedAt) : null, prNumber: first.prNumber,
      prUrl: first.prUrl, prLifecycleStatus: first.prLifecycleStatus, mergedAt: first.mergedAt ? new Date(first.mergedAt) : null,
    } : null,
    ...over,
  };
}

export function boardFixture(moment: 'running' | 'question' | 'complete' | 'planning'): MissionBoardModel {
  if (moment === 'planning') {
    return buildMissionBoard({
      tasks: [t('plan', 1, {
        title: 'Mission: Example goal', taskClass: 'bookkeeping', mode: 'planning', status: 'in_progress', roleSlug: 'organizer',
        missionPhaseIndex: null, missionPhaseLabel: null, outputRequirement: null,
        workers: [w({ runner: 'alpha', startedAt: min(0), milestones: [{ ts: min(1), label: 'Mapped the example tables' }] })],
      })],
      roles: [{ slug: 'organizer', name: 'Organizer', color: 'var(--test-role-colour)' }],
      now: min(2),
      missionCreatedAt: BOARD_T0,
      missionStatus: 'active',
    });
  }
  const done = moment === 'complete';
  const tasks: BoardTaskInput[] = [
    t('base', 1, { status: 'completed', workers: [w({ status: 'completed', completedAt: min(4), prNumber: 101, mergedAt: min(5), linesAdded: 40, linesRemoved: 2 })] }),
    t('api', 1, {
      status: done ? 'completed' : 'in_progress', dependsOn: ['base'],
      workers: [w({
        runner: 'beta', startedAt: min(2),
        ...(done ? { status: 'completed', completedAt: min(9), prNumber: 102, mergedAt: min(10) } : {}),
        milestones: [{ ts: min(3), label: 'Reading the handlers' }, { ts: min(6), label: 'Writing the endpoint' }],
      })],
    }),
    t('pay', 2, {
      status: done ? 'completed' : 'in_progress', dependsOn: ['base'],
      workers: [w({
        runner: 'alpha', startedAt: min(6),
        ...(moment === 'question' ? { status: 'waiting_input', updatedAt: min(11), waitingFor: { prompt: 'Round each line or the total?', options: ['Each line — matches the charge', 'Total only'] } } : {}),
        ...(done ? { status: 'completed', completedAt: min(14), prNumber: 103, mergedAt: min(15) } : {}),
      })],
    }),
    t('guide', 2, done
      ? { status: 'completed', dependsOn: ['api'], workers: [w({ runner: 'beta', status: 'completed', startedAt: min(10), completedAt: min(16), prNumber: 104, mergedAt: min(17) })] }
      : { dependsOn: ['api'] }),
  ];
  return buildMissionBoard({
    tasks,
    roles: [{ slug: 'builder', name: 'Builder', color: 'var(--test-role-colour)' }],
    now: done ? min(30) : min(12),
    missionCreatedAt: BOARD_T0,
    missionCompletedAt: done ? min(18) : null,
    missionStatus: done ? 'completed' : 'active',
    criteria: [{ type: 'all_prs_merged' }, { type: 'no_open_tasks' }],
    criteriaState: done ? [{ index: 0, verdict: 'pass' }, { index: 1, verdict: 'pass' }] : [],
    humanTouches: done ? [min(12)] : [],
  });
}
