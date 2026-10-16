/**
 * The live run view's props (RealTimeWorkerView), built once for the task
 * page and the mission sheet. Illustrative fixtures only.
 */
import { describe, expect, it } from 'bun:test';
import { liveWorkerOf, liveWorkerViewProps, workerSteerProps } from './task-live-view';

const T = new Date('2026-01-01T12:00:00Z');
const row = {
  id: 'w1', name: 'builder', branch: 'buildd/abc-task', status: 'running', currentAction: 'Editing a file',
  milestones: [{ type: 'status', label: 'go', ts: 1 }], turns: 4, costUsd: '0.25', inputTokens: 10, outputTokens: 20,
  createdAt: T, startedAt: T, updatedAt: T, mergedAt: null, dirtyWorktree: false, observedTouches: ['a.ts'], prIsDraft: null,
  prUrl: null, prNumber: null, prLifecycleStatus: null, commitCount: 1, filesChanged: 1, linesAdded: 3, linesRemoved: 0,
  lastCommitSha: 'abc1234', waitingFor: null, error: null, instructionHistory: null, pendingInstructions: null, resultMeta: null,
};

describe('liveWorkerOf', () => {
  it("serializes a worker row as the live view reads it, JSON-safe", () => {
    const w = liveWorkerOf(row as never);
    expect(w).toMatchObject({ id: 'w1', name: 'builder', branch: 'buildd/abc-task', costUsd: '0.25', startedAt: T.toISOString(), updatedAt: T.toISOString(), instructionHistory: [], localUiUrl: null });
    expect(JSON.parse(JSON.stringify(w))).toEqual(w);
  });

  it('reads a numeric cost as a string and missing times as null', () => {
    const w = liveWorkerOf({ ...row, costUsd: 0.5, startedAt: null, milestones: null } as never);
    expect(w.costUsd).toBe('0.5');
    expect(w.startedAt).toBeNull();
    expect(w.milestones).toEqual([]);
  });
});

describe('liveWorkerViewProps', () => {
  it('carries the task and the delivery beside the worker', () => {
    const p = liveWorkerViewProps({
      task: { id: 't1', status: 'in_progress', outputRequirement: 'pr_required' },
      worker: row as never, delivery: null, deliverableArtifactCount: 2, usesReviewer: true, reviewState: 'pending',
      modelTier: 'Standard', questionNote: null, roleName: 'Builder',
    });
    expect(p).toMatchObject({ taskId: 't1', taskStatus: 'in_progress', outputRequirement: 'pr_required', deliverableArtifactCount: 2, usesReviewer: true, reviewState: 'pending', modelTier: 'Standard', roleName: 'Builder' });
    expect(p.initialWorker.id).toBe('w1');
  });
});

describe('workerSteerProps', () => {
  const at = (m: number) => new Date(T.getTime() + m * 60_000);
  it("names the run before this one, by creation time, whatever the list order", () => {
    const active = { id: 'w3', createdAt: at(3), status: 'running', waitingFor: null, instructionHistory: [{ message: 'hi', timestamp: 1, type: 'instruction' }], runner: 'atlas' };
    const workers = [{ id: 'w1', createdAt: at(1), status: 'failed', instructionHistory: null }, active, { id: 'w2', createdAt: at(2), status: 'failed', instructionHistory: [] }];
    const p = workerSteerProps(active, workers, false);
    expect(p).toMatchObject({ workerId: 'w3', status: 'running', hasUnansweredQuestion: false, runner: 'atlas', taskTerminal: false });
    expect(p.instructionHistory).toHaveLength(1);
    expect(p.earlierRun).toEqual({ workerId: 'w2', status: 'failed', history: [] });
  });

  it('has no earlier run for the first one', () => {
    const active = { id: 'w1', createdAt: at(1), status: 'waiting_input', waitingFor: { prompt: 'q?' } };
    expect(workerSteerProps(active, [active], false)).toMatchObject({ hasUnansweredQuestion: true, earlierRun: null, instructionHistory: [] });
  });
});
