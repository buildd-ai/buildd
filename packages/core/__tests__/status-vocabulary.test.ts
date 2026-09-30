/**
 * The canonical status vocabularies in @buildd/shared (packages/shared/src/status.ts).
 * Lives here because packages/shared has no collected test root; core depends on it.
 */
import { describe, it, expect } from 'bun:test';
import {
  TASK_STATUSES,
  WORKER_STATUSES,
  MISSION_STATUSES,
  OPEN_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  LIVE_WORKER_STATUSES,
  TERMINAL_WORKER_STATUSES,
  TaskStatus,
  WorkerStatus,
  MissionStatus,
  isOpenTaskStatus,
  isTerminalTaskStatus,
  isLiveWorkerStatus,
  isTerminalWorkerStatus,
  canDeleteTask,
} from '@buildd/shared';

describe('status unions cover every stored value', () => {
  it('tasks include cancelled', () => {
    expect(TASK_STATUSES).toContain('cancelled');
    expect(Object.values(TaskStatus)).toContain('cancelled');
  });
  it('workers include failed, superseded and the legacy done', () => {
    for (const s of ['failed', 'superseded', 'done'] as const) {
      expect(WORKER_STATUSES).toContain(s);
      expect(Object.values(WorkerStatus)).toContain(s);
    }
  });
  it('missions include budget_exhausted', () => {
    expect(MISSION_STATUSES).toContain('budget_exhausted');
    expect(Object.values(MissionStatus)).toContain('budget_exhausted');
  });
  it('the const objects and the lists name the same values', () => {
    expect(new Set(Object.values(TaskStatus))).toEqual(new Set(TASK_STATUSES));
    expect(new Set(Object.values(WorkerStatus))).toEqual(new Set(WORKER_STATUSES));
    expect(new Set(Object.values(MissionStatus))).toEqual(new Set(MISSION_STATUSES));
  });
});

describe('task partitions', () => {
  it('open and terminal are disjoint and exclude the never-written review', () => {
    for (const s of OPEN_TASK_STATUSES) expect(TERMINAL_TASK_STATUSES as readonly string[]).not.toContain(s);
    expect(isOpenTaskStatus('review')).toBe(false);
    expect(isTerminalTaskStatus('review')).toBe(false);
  });
  it('a cancel is terminal', () => {
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isOpenTaskStatus('cancelled')).toBe(false);
  });
  it('predicates tolerate null and unknown values', () => {
    expect(isOpenTaskStatus(null)).toBe(false);
    expect(isTerminalTaskStatus(undefined)).toBe(false);
    expect(isTerminalTaskStatus('bogus')).toBe(false);
  });
});

describe('worker partitions', () => {
  it('idle is live; paused is neither live nor terminal', () => {
    expect(isLiveWorkerStatus('idle')).toBe(true);
    expect(isLiveWorkerStatus('paused')).toBe(false);
    expect(isTerminalWorkerStatus('paused')).toBe(false);
  });
  it('superseded and done are terminal', () => {
    expect(isTerminalWorkerStatus('superseded')).toBe(true);
    expect(isTerminalWorkerStatus('done')).toBe(true);
  });
  it('live and terminal are disjoint', () => {
    for (const s of LIVE_WORKER_STATUSES) expect(TERMINAL_WORKER_STATUSES as readonly string[]).not.toContain(s);
  });
});

describe('canDeleteTask', () => {
  it('allows everything but a running task', () => {
    for (const s of ['pending', 'assigned', 'completed', 'failed', 'cancelled']) expect(canDeleteTask(s)).toBe(true);
    expect(canDeleteTask('in_progress')).toBe(false);
  });
});
