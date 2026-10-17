'use client';

/**
 * `?state=task-sheet`: the mission task sheet over nothing, showing the task
 * page's sections it renders (lib/task-sections.ts, lib/task-live-view.ts):
 * the header pill, the stored PR card, the runner and branch facts,
 * Deliverables and Access. `&sheet=live` shows a running task instead: the
 * delivery's header reading, its checks, the live run view and steer panel.
 * Illustrative data only — no real task, PR or runner.
 */
import { useSearchParams } from 'next/navigation';
import { TaskSheetView, useTaskSheetLayout } from '../../(protected)/missions/[id]/TaskSheet';
import type { TaskPanelData } from '../../(protected)/missions/[id]/TaskPanel';
import { liveWorkerViewProps, workerSteerProps } from '@/lib/task-live-view';
import { taskDeliverySections } from '@/lib/task-sections';

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
  deliverables: {
    summary: 'Session rows now read **studio-mini** instead of a local URL. Added a test for a runner with no heartbeat.',
    summarySource: 'fallback',
    branch: 'buildd/a1b2c3d4-runner-name-on-sessions',
    commits: 3, added: 86, removed: 12, files: 4,
  },
  access: [
    { at: new Date(Date.now() - 3 * 3600_000).toISOString(), lastAt: new Date(Date.now() - 3 * 3600_000).toISOString(), count: 1, capability: 'github.repo_grant', label: 'GitHub repo access', decision: 'allowed', reason: null, target: 'example/app', expiresAt: null, workerId: 'w-fixture' },
    { at: new Date(Date.now() - 2 * 3600_000).toISOString(), lastAt: new Date(Date.now() - 2 * 3600_000).toISOString(), count: 1, capability: 'buildd.cross_task', label: 'Read another task', decision: 'refused', reason: 'Outside this task', target: null, expiresAt: null, workerId: 'w-fixture' },
  ],
};

const LIVE_ID = 'fixture-task-sheet-live';
const startedAt = new Date(Date.now() - 6 * 60_000).toISOString();
const liveRow = {
  id: 'w-fixture-live', name: 'builder', branch: 'buildd/e5f6a7b8-export-both-currencies', status: 'running',
  currentAction: 'Editing apps/web/src/lib/export.ts',
  milestones: [
    { type: 'status', label: 'Reading the export module', ts: Date.now() - 5 * 60_000 },
    { type: 'status', label: 'Editing apps/web/src/lib/export.ts', ts: Date.now() - 60_000 },
  ],
  turns: 9, costUsd: null, inputTokens: 41_000, outputTokens: 3_200, createdAt: startedAt, startedAt, updatedAt: new Date().toISOString(),
  prUrl: 'https://github.com/example/app/pull/57', prNumber: 57, commitCount: 1, filesChanged: 2, linesAdded: 30, linesRemoved: 4,
  lastCommitSha: 'c0ffee1', waitingFor: null, instructionHistory: [], pendingInstructions: null,
};
const liveSections = taskDeliverySections({
  view: {
    state: 'AWAITING_REVIEW', stateReason: null, prNumber: 57, headSha: 'c0ffee1', prState: 'ci_passed',
    rounds: [{ id: 'r1', round: 1, headSha: 'c0ffee1', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0, reviewerTaskId: null }],
    ledger: [], approvedCurrentHead: false, approvalBasis: null,
    headline: 'Waiting for review', owner: 'reviewer', needsYou: false, stage: 'review', detail: null, repoFullName: 'example/app',
  } as never,
  findings: new Map(),
  findingsUnavailable: false,
}, { prUrl: liveRow.prUrl });

export const TASK_SHEET_LIVE_FIXTURE_DATA: TaskPanelData = {
  id: LIVE_ID,
  title: 'feat(export): the accounting CSV carries both currencies',
  status: 'in_progress',
  description: 'Add the original currency beside the converted amount in the CSV export.',
  mode: null,
  roleSlug: 'builder',
  createdAt: startedAt,
  missionId: null,
  backend: 'claude',
  failover: null,
  worker: {
    id: liveRow.id, status: 'running', currentAction: liveRow.currentAction, turns: 9,
    prUrl: liveRow.prUrl, prNumber: 57, prLifecycleStatus: 'ci_green', mergedAt: null,
    commitCount: 1, filesChanged: 2, linesAdded: 30, linesRemoved: 4, costUsd: null, inputTokens: 41_000, outputTokens: 3_200,
    startedAt, completedAt: null, waitingFor: null, branch: liveRow.branch, runner: 'studio-mini', milestones: [], account: null,
  },
  result: null,
  pr: { prUrl: liveRow.prUrl, prNumber: 57, prLifecycleStatus: 'ci_green', prState: 'ci_passed', linesAdded: 30, linesRemoved: 4, filesChanged: 2 },
  merged: false,
  lastError: null,
  blockedByCount: 0,
  delivery: liveSections.delivery,
  checks: liveSections.checks,
  live: liveWorkerViewProps({
    task: { id: LIVE_ID, status: 'in_progress', outputRequirement: 'pr_required' },
    worker: liveRow,
    delivery: liveSections.delivery,
    deliverableArtifactCount: 0,
    usesReviewer: true,
    modelTier: 'Standard',
    roleName: 'Builder',
  }),
  steer: workerSteerProps(liveRow, [liveRow], false),
};

export default function TaskSheetFixture() {
  const layout = useTaskSheetLayout();
  const live = useSearchParams().get('sheet') === 'live';
  const data = live ? TASK_SHEET_LIVE_FIXTURE_DATA : TASK_SHEET_FIXTURE_DATA;
  return (
    <TaskSheetView
      taskId={data.id}
      layout={layout}
      mission={null}
      nav={{ position: null, prevTaskId: null, nextTaskId: null, nextNeedingYou: null }}
      summary={{ data, loading: false, error: null }}
      onChanged={() => {}}
      onClose={() => {}}
      onStep={() => {}}
    />
  );
}
