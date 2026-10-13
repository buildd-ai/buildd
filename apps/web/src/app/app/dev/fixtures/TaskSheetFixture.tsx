'use client';

/**
 * `?state=task-sheet`: the mission task sheet over nothing, showing the task
 * page's sections it now shares (lib/task-sections.ts): the header pill, the
 * stored PR card, the runner and branch facts and the summary card.
 * Illustrative data only — no real task, PR or runner.
 */
import { TaskSheetView, useTaskSheetLayout } from '../../(protected)/missions/[id]/TaskSheet';
import type { TaskPanelData } from '../../(protected)/missions/[id]/TaskPanel';

const TASK_ID = 'fixture-task-sheet';

export const TASK_SHEET_FIXTURE_DATA: TaskPanelData = {
  id: TASK_ID,
  title: 'feat(settings): show the runner name on each session row',
  status: 'completed',
  description: 'Each session row names the runner it ran on, by hostname.',
  mode: null,
  roleSlug: 'builder',
  createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  missionId: null,
  backend: 'claude',
  failover: null,
  worker: {
    id: 'w-fixture', status: 'completed', currentAction: null, turns: 18,
    prUrl: 'https://github.com/example/app/pull/42', prNumber: 42, prLifecycleStatus: 'merged', mergedAt: new Date().toISOString(),
    commitCount: 3, filesChanged: 4, linesAdded: 86, linesRemoved: 12, costUsd: null, inputTokens: 0, outputTokens: 0,
    startedAt: null, completedAt: null, waitingFor: null, branch: 'buildd/a1b2c3d4-runner-name-on-sessions',
    runner: 'studio-mini', milestones: [], account: null,
  },
  result: {
    summary: 'Session rows now read **studio-mini** instead of a local URL. Added a test for a runner with no heartbeat.',
    nextSuggestion: null,
    fallback: true,
  },
  pr: {
    prUrl: 'https://github.com/example/app/pull/42', prNumber: 42, prLifecycleStatus: 'merged', prState: 'merged',
    linesAdded: 86, linesRemoved: 12, filesChanged: 4,
  },
  merged: true,
  lastError: null,
  blockedByCount: 0,
};

export default function TaskSheetFixture() {
  const layout = useTaskSheetLayout();
  return (
    <TaskSheetView
      taskId={TASK_ID}
      layout={layout}
      mission={null}
      nav={{ position: null, prevTaskId: null, nextTaskId: null, nextNeedingYou: null }}
      summary={{ data: TASK_SHEET_FIXTURE_DATA, loading: false, error: null }}
      onChanged={() => {}}
      onClose={() => {}}
      onStep={() => {}}
    />
  );
}
