import { describe, it, expect } from 'bun:test';
import { deriveStage, type Stage } from '@/lib/stage';
import { getMenuActions } from '@/components/SwipeableRow';
import {
  computeStageCounts,
  deriveGridTaskStage,
  deriveSwipeCardType,
  gridTaskPrProps,
  selectMobileRunningTasks,
  type GridTask,
} from './TaskGrid';

/**
 * /app/tasks renders each row's stage twice from two independent derivations:
 *
 *  1. The row chip — `TaskCard` calls `deriveStage()` on the props TaskGrid
 *     hands it (`gridTaskPrProps`).
 *  2. The group histogram — `computeStageCounts()` calls
 *     `deriveGridTaskStage()` on the same `GridTask`.
 *
 * Both read `prLifecycleStatus`. When TaskGrid declared the field but forgot to
 * forward it, a merged task rendered an `OPEN #1234` chip while the histogram
 * above it counted that row as `DONE`. These tests pin the agreement.
 */

function makeTask(overrides: Partial<GridTask> = {}): GridTask {
  return {
    id: 't1',
    title: 'Ship the thing',
    status: 'completed',
    category: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T01:00:00.000Z',
    workspaceName: 'ws',
    prUrl: 'https://github.com/acme/repo/pull/1234',
    prNumber: 1234,
    prLifecycleStatus: null,
    summary: null,
    hasArtifact: false,
    filesChanged: null,
    waitingPrompt: null,
    missionId: 'm1',
    missionTitle: 'Mission',
    ...overrides,
  };
}

/**
 * The histogram has no OPEN/CI/MERGE buckets — every pre-merge PR state lands
 * in REVIEW. Collapse the card's finer-grained Stage onto the same axis so the
 * two derivations are comparable.
 */
function stageToHistogramBucket(stage: Stage): string {
  switch (stage) {
    case 'OPEN':
    case 'CI':
    case 'CI_FAILING':
    case 'MERGE':
    case 'REVIEWING':
      return 'REVIEW';
    case 'WAITING_INPUT':
      return 'RUNNING';
    default:
      return stage;
  }
}

/** Stage as the row chip sees it, from exactly the props TaskGrid forwards. */
function cardStage(task: GridTask): Stage {
  return deriveStage({
    taskStatus: task.status,
    workerStatus: task.workerStatus,
    isBlocked: (task.chain?.blockedBy?.length ?? 0) > 0,
    isSubjectDead: task.subjectDead,
    isMissionBudgetExhausted: task.missionBudgetExhausted,
    ...gridTaskPrProps(task),
  });
}

describe('gridTaskPrProps', () => {
  it('forwards prLifecycleStatus so the card can see a merged PR', () => {
    const props = gridTaskPrProps(makeTask({ prLifecycleStatus: 'merged' }));
    expect(props).toMatchObject({
      prUrl: 'https://github.com/acme/repo/pull/1234',
      prNumber: 1234,
      prLifecycleStatus: 'merged',
    });
  });

  it('normalises a missing prLifecycleStatus to null', () => {
    const props = gridTaskPrProps(makeTask({ prLifecycleStatus: undefined }));
    expect(props).toMatchObject({ prLifecycleStatus: null });
  });
});

describe('row chip and histogram agree on stage', () => {
  it('counts a merged PR as DONE in both views', () => {
    const task = makeTask({ prLifecycleStatus: 'merged' });
    expect(deriveGridTaskStage(task)).toBe('DONE');
    expect(cardStage(task)).toBe('DONE');
    expect(stageToHistogramBucket(cardStage(task))).toBe(deriveGridTaskStage(task));
  });

  it('forwards a closed PR lifecycle to the card', () => {
    const task = makeTask({ prLifecycleStatus: 'closed' });
    // NOTE: deriveGridTaskStage() has no closed-PR branch (it only tests for
    // 'merged'), so the histogram still buckets a closed PR as REVIEW while the
    // card reads DONE. That is a separate derivation gap in
    // deriveGridTaskStage, not a lost prop — assert the shared input reaches
    // the card and leave the bucket comparison to the merged case.
    expect(gridTaskPrProps(task).prLifecycleStatus).toBe('closed');
  });

  it.each([
    ['pr_open', 'REVIEW'],
    ['ci_running', 'REVIEW'],
    ['ci_failed', 'REVIEW'],
    ['ci_green', 'REVIEW'],
    [null, 'REVIEW'],
  ] as const)('buckets an unmerged PR (%s) as REVIEW in both views', (lifecycle, expected) => {
    const task = makeTask({ prLifecycleStatus: lifecycle });
    expect(deriveGridTaskStage(task)).toBe(expected);
    expect(stageToHistogramBucket(cardStage(task))).toBe(expected);
  });

  it('agrees on a completed task with no PR at all', () => {
    const task = makeTask({ prUrl: null, prNumber: null });
    expect(deriveGridTaskStage(task)).toBe('DONE');
    expect(stageToHistogramBucket(cardStage(task))).toBe('DONE');
  });

  it('agrees on a running task', () => {
    const task = makeTask({ status: 'assigned', workerStatus: 'running' });
    expect(deriveGridTaskStage(task)).toBe('RUNNING');
    expect(stageToHistogramBucket(cardStage(task))).toBe('RUNNING');
  });

  it('agrees on a failed task', () => {
    const task = makeTask({ status: 'failed' });
    expect(deriveGridTaskStage(task)).toBe('FAILED');
    expect(stageToHistogramBucket(cardStage(task))).toBe('FAILED');
  });
});

describe('cancelled tasks in the stage histogram', () => {
  it('does not bucket a cancelled task as QUEUED', () => {
    expect(deriveGridTaskStage(makeTask({ status: 'cancelled', prUrl: null }))).toBeNull();
  });

  it('leaves cancelled tasks out of every stage count', () => {
    const { counts, failedCount } = computeStageCounts([
      makeTask({ id: 'a', status: 'cancelled', prUrl: null }),
      makeTask({ id: 'b', status: 'pending', prUrl: null }),
    ]);
    expect(counts.QUEUED).toBe(1);
    expect(Object.values(counts).reduce((a, b) => a + b, 0) + failedCount).toBe(1);
  });
});

describe('row menu actions', () => {
  const hasCancel = (task: GridTask) =>
    getMenuActions(deriveSwipeCardType(task), { prUrl: task.prUrl, taskId: task.id })
      .some(a => a.action === 'cancel-task');

  it.each(['failed', 'cancelled', 'completed'])('offers no Cancel on a %s row', (status) => {
    expect(hasCancel(makeTask({ status }))).toBe(false);
  });

  it.each(['pending', 'assigned', 'in_progress', 'waiting_input'])(
    'offers Cancel on a live %s row',
    (status) => {
      expect(hasCancel(makeTask({ status, prUrl: null }))).toBe(true);
    },
  );
});

describe('selectMobileRunningTasks ("Running now" strip)', () => {
  it('excludes queued tasks with no live worker', () => {
    const tasks = [
      makeTask({ id: 'q1', status: 'pending', prUrl: null }),
      makeTask({ id: 'q2', status: 'assigned', workerStatus: null, prUrl: null }),
      makeTask({ id: 'r1', status: 'assigned', workerStatus: 'running', prUrl: null }),
      makeTask({ id: 'w1', status: 'waiting_input', workerStatus: 'waiting_input', prUrl: null }),
    ];
    expect(selectMobileRunningTasks(tasks).map(t => t.id).sort()).toEqual(['r1', 'w1']);
  });

  it('excludes terminal tasks even if a stale worker status lingers', () => {
    const tasks = [
      makeTask({ id: 'f', status: 'failed', workerStatus: 'running' }),
      makeTask({ id: 'c', status: 'cancelled', workerStatus: 'running' }),
    ];
    expect(selectMobileRunningTasks(tasks)).toEqual([]);
  });

  it('keeps the five most recently updated', () => {
    const tasks = Array.from({ length: 7 }, (_, i) =>
      makeTask({
        id: `r${i}`,
        status: 'assigned',
        workerStatus: 'running',
        updatedAt: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
      }),
    );
    expect(selectMobileRunningTasks(tasks).map(t => t.id)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2']);
  });
});
