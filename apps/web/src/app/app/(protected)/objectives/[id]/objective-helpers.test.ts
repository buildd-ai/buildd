import { describe, test, expect } from 'bun:test';
import {
  extractRunHistory,
  getLatestReport,
  collectArtifacts,
  categorizeArtifacts,
  collectRecentActivity,
  extractInsights,
  timeAgo,
  type TaskData,
  type TaskResult,
  type ObjectiveArtifact,
} from './objective-helpers';

// ─── Fixtures ───────────────────────────────────────────────────

function makePlanningTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: 'task-plan-1',
    title: 'Planning: Finance check-in',
    status: 'completed',
    priority: 5,
    createdAt: new Date('2026-03-08T10:00:00Z'),
    mode: 'planning',
    result: {
      summary: '**Transactions**: 333 personal, 100% classified\n**Overdue**: None',
      structuredOutput: { tasksCreated: 2, objectiveComplete: false },
    } as TaskResult,
    workers: [],
    ...overrides,
  };
}

function makeExecutionTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: 'task-exec-1',
    title: 'Update spending report',
    status: 'completed',
    priority: 5,
    createdAt: new Date('2026-03-08T10:05:00Z'),
    mode: 'execution',
    result: {
      summary: 'Updated spending report artifact',
      structuredOutput: { spendingTotal: 72700 },
    } as TaskResult,
    workers: [
      {
        id: 'w-1',
        status: 'completed',
        branch: 'task/update-report',
        prUrl: null,
        prNumber: null,
        costUsd: '0.05',
        turns: 3,
        completedAt: new Date('2026-03-08T10:10:00Z'),
        startedAt: new Date('2026-03-08T10:05:00Z'),
        currentAction: null,
        commitCount: 1,
        filesChanged: 2,
        artifacts: [
          { id: 'art-1', type: 'report', title: 'Spending Report', key: 'spending-report', shareToken: 'abc123', content: '# Spending Report\n\nTotal: $72,700' },
          { id: 'art-2', type: 'content', title: 'Log Entry', key: null, shareToken: 'def456', content: 'Some log content' },
        ],
      },
    ],
    ...overrides,
  };
}

// ─── extractRunHistory ──────────────────────────────────────────

describe('extractRunHistory', () => {
  test('extracts completed planning tasks', () => {
    const tasks = [
      makePlanningTask(),
      makeExecutionTask(),
      makePlanningTask({ id: 'task-plan-2', status: 'failed' }),
    ];
    const history = extractRunHistory(tasks);
    expect(history).toHaveLength(1);
    expect(history[0].taskId).toBe('task-plan-1');
  });

  test('extracts summary and structured output fields', () => {
    const history = extractRunHistory([makePlanningTask()]);
    expect(history[0].summary).toContain('**Transactions**');
    expect(history[0].tasksCreated).toBe(2);
    expect(history[0].objectiveComplete).toBe(false);
  });

  test('handles tasks with no result', () => {
    const task = makePlanningTask({ result: null });
    const history = extractRunHistory([task]);
    expect(history).toHaveLength(1);
    expect(history[0].summary).toBeUndefined();
    expect(history[0].tasksCreated).toBeUndefined();
    expect(history[0].objectiveComplete).toBe(false);
  });

  test('handles tasks with no structuredOutput', () => {
    const task = makePlanningTask({ result: { summary: 'Just a summary' } as TaskResult });
    const history = extractRunHistory([task]);
    expect(history[0].summary).toBe('Just a summary');
    expect(history[0].tasksCreated).toBeUndefined();
  });

  test('filters out non-planning tasks', () => {
    const history = extractRunHistory([makeExecutionTask()]);
    expect(history).toHaveLength(0);
  });

  test('filters out non-completed planning tasks', () => {
    const tasks = [
      makePlanningTask({ status: 'running' }),
      makePlanningTask({ status: 'pending' }),
      makePlanningTask({ status: 'failed' }),
    ];
    expect(extractRunHistory(tasks)).toHaveLength(0);
  });

  test('returns empty for empty input', () => {
    expect(extractRunHistory([])).toHaveLength(0);
  });

  test('preserves order from input', () => {
    const tasks = [
      makePlanningTask({ id: 'first', createdAt: new Date('2026-03-08T10:00:00Z') }),
      makePlanningTask({ id: 'second', createdAt: new Date('2026-03-08T09:00:00Z') }),
    ];
    const history = extractRunHistory(tasks);
    expect(history[0].taskId).toBe('first');
    expect(history[1].taskId).toBe('second');
  });
});

// ─── getLatestReport ────────────────────────────────────────────

describe('getLatestReport', () => {
  test('returns first run with non-empty summary', () => {
    const runs = extractRunHistory([
      makePlanningTask({ id: 'latest' }),
      makePlanningTask({ id: 'older', createdAt: new Date('2026-03-07T10:00:00Z') }),
    ]);
    const report = getLatestReport(runs);
    expect(report).not.toBeNull();
    expect(report!.taskId).toBe('latest');
  });

  test('skips runs with empty/whitespace summary', () => {
    const runs = [
      { taskId: 'no-summary', createdAt: new Date(), summary: '   ', tasksCreated: 0, objectiveComplete: false },
      { taskId: 'has-summary', createdAt: new Date(), summary: 'Real report', tasksCreated: 1, objectiveComplete: false },
    ];
    const report = getLatestReport(runs);
    expect(report!.taskId).toBe('has-summary');
  });

  test('skips runs with undefined summary', () => {
    const runs = [
      { taskId: 'no-summary', createdAt: new Date(), summary: undefined, tasksCreated: 0, objectiveComplete: false },
      { taskId: 'has-summary', createdAt: new Date(), summary: 'Report content', tasksCreated: 0, objectiveComplete: false },
    ];
    expect(getLatestReport(runs)!.taskId).toBe('has-summary');
  });

  test('returns null when no runs have summaries', () => {
    const runs = [
      { taskId: 'a', createdAt: new Date(), summary: undefined, tasksCreated: 0, objectiveComplete: false },
      { taskId: 'b', createdAt: new Date(), summary: '', tasksCreated: 0, objectiveComplete: false },
    ];
    expect(getLatestReport(runs)).toBeNull();
  });

  test('returns null for empty run history', () => {
    expect(getLatestReport([])).toBeNull();
  });
});

// ─── collectArtifacts ───────────────────────────────────────────

describe('collectArtifacts', () => {
  test('collects artifacts from all workers across all tasks', () => {
    const tasks = [makeExecutionTask()];
    const artifacts = collectArtifacts(tasks);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].title).toBe('Spending Report');
    expect(artifacts[0].taskTitle).toBe('Update spending report');
    expect(artifacts[0].workerStatus).toBe('completed');
  });

  test('handles tasks with no workers', () => {
    const task = makeExecutionTask({ workers: [] });
    expect(collectArtifacts([task])).toHaveLength(0);
  });

  test('handles workers with no artifacts', () => {
    const task = makeExecutionTask();
    task.workers![0].artifacts = [];
    expect(collectArtifacts([task])).toHaveLength(0);
  });

  test('handles undefined workers', () => {
    const task = makePlanningTask(); // no workers property or empty
    expect(collectArtifacts([task])).toHaveLength(0);
  });

  test('returns empty for empty input', () => {
    expect(collectArtifacts([])).toHaveLength(0);
  });

  test('collects from multiple tasks and workers', () => {
    const task1 = makeExecutionTask({ id: 't1', title: 'Task 1' });
    const task2 = makeExecutionTask({ id: 't2', title: 'Task 2' });
    task2.workers![0].artifacts = [
      { id: 'art-3', type: 'data', title: 'Data Export', key: 'data-export', shareToken: null },
    ];
    const artifacts = collectArtifacts([task1, task2]);
    expect(artifacts).toHaveLength(3);
    expect(artifacts[2].taskTitle).toBe('Task 2');
  });
});

// ─── categorizeArtifacts ────────────────────────────────────────

describe('categorizeArtifacts', () => {
  test('separates keyed from regular artifacts', () => {
    const artifacts: ObjectiveArtifact[] = [
      { id: '1', type: 'report', title: 'Report', key: 'spending-report', shareToken: 'abc', taskTitle: 'T1', workerStatus: 'completed' },
      { id: '2', type: 'content', title: 'Log', key: null, shareToken: 'def', taskTitle: 'T1', workerStatus: 'completed' },
      { id: '3', type: 'data', title: 'Data', key: 'data-export', shareToken: null, taskTitle: 'T2', workerStatus: 'completed' },
    ];
    const { keyed, regular } = categorizeArtifacts(artifacts);
    expect(keyed).toHaveLength(2);
    expect(regular).toHaveLength(1);
    expect(keyed[0].key).toBe('spending-report');
    expect(keyed[1].key).toBe('data-export');
    expect(regular[0].key).toBeNull();
  });

  test('returns all as regular when none are keyed', () => {
    const artifacts: ObjectiveArtifact[] = [
      { id: '1', type: 'content', title: 'A', key: null, shareToken: null, taskTitle: 'T', workerStatus: 'completed' },
    ];
    const { keyed, regular } = categorizeArtifacts(artifacts);
    expect(keyed).toHaveLength(0);
    expect(regular).toHaveLength(1);
  });

  test('returns all as keyed when all are keyed', () => {
    const artifacts: ObjectiveArtifact[] = [
      { id: '1', type: 'report', title: 'A', key: 'key-a', shareToken: null, taskTitle: 'T', workerStatus: 'completed' },
    ];
    const { keyed, regular } = categorizeArtifacts(artifacts);
    expect(keyed).toHaveLength(1);
    expect(regular).toHaveLength(0);
  });

  test('handles empty input', () => {
    const { keyed, regular } = categorizeArtifacts([]);
    expect(keyed).toHaveLength(0);
    expect(regular).toHaveLength(0);
  });
});

// ─── collectRecentActivity ──────────────────────────────────────

describe('collectRecentActivity', () => {
  test('sorts by most recent first (completedAt > startedAt)', () => {
    const tasks: TaskData[] = [
      makeExecutionTask({
        id: 't1', title: 'Older',
        workers: [{
          id: 'w1', status: 'completed', branch: null, prUrl: null, prNumber: null,
          costUsd: null, turns: 1, commitCount: 0, filesChanged: 0,
          currentAction: null,
          startedAt: new Date('2026-03-08T08:00:00Z'),
          completedAt: new Date('2026-03-08T08:30:00Z'),
          artifacts: [],
        }],
      }),
      makeExecutionTask({
        id: 't2', title: 'Newer',
        workers: [{
          id: 'w2', status: 'completed', branch: null, prUrl: null, prNumber: null,
          costUsd: null, turns: 2, commitCount: 1, filesChanged: 3,
          currentAction: null,
          startedAt: new Date('2026-03-08T09:00:00Z'),
          completedAt: new Date('2026-03-08T09:30:00Z'),
          artifacts: [],
        }],
      }),
    ];
    const activity = collectRecentActivity(tasks);
    expect(activity[0].taskTitle).toBe('Newer');
    expect(activity[1].taskTitle).toBe('Older');
  });

  test('respects limit parameter', () => {
    const workers = Array.from({ length: 10 }, (_, i) => ({
      id: `w-${i}`, status: 'completed', branch: null, prUrl: null, prNumber: null,
      costUsd: null, turns: 1, commitCount: 0, filesChanged: 0,
      currentAction: null,
      startedAt: new Date(`2026-03-0${Math.min(i + 1, 8)}T10:00:00Z`),
      completedAt: null,
      artifacts: [],
    }));
    const tasks: TaskData[] = [{
      id: 't1', title: 'Many workers', status: 'completed', priority: 5,
      createdAt: new Date(), mode: 'execution', result: null,
      workers,
    }];
    expect(collectRecentActivity(tasks, 3)).toHaveLength(3);
    expect(collectRecentActivity(tasks)).toHaveLength(8); // default limit
  });

  test('handles workers with only startedAt', () => {
    const tasks: TaskData[] = [
      makeExecutionTask({
        id: 't1', workers: [{
          id: 'w1', status: 'running', branch: null, prUrl: null, prNumber: null,
          costUsd: null, turns: 1, commitCount: 0, filesChanged: 0,
          currentAction: 'Working on it',
          startedAt: new Date('2026-03-08T10:00:00Z'),
          completedAt: null,
          artifacts: [],
        }],
      }),
    ];
    const activity = collectRecentActivity(tasks);
    expect(activity).toHaveLength(1);
    expect(activity[0].currentAction).toBe('Working on it');
  });

  test('returns empty for tasks without workers', () => {
    const tasks: TaskData[] = [makePlanningTask()];
    expect(collectRecentActivity(tasks)).toHaveLength(0);
  });
});

// ─── extractInsights ────────────────────────────────────────────

describe('extractInsights', () => {
  test('extracts structured output from completed execution tasks', () => {
    const insights = extractInsights([makeExecutionTask()]);
    expect(insights).toHaveLength(1);
    expect(insights[0].structuredOutput).toEqual({ spendingTotal: 72700 });
  });

  test('excludes planning tasks', () => {
    const insights = extractInsights([makePlanningTask()]);
    expect(insights).toHaveLength(0);
  });

  test('excludes tasks without structuredOutput', () => {
    const task = makeExecutionTask({ result: { summary: 'No structured output' } as TaskResult });
    expect(extractInsights([task])).toHaveLength(0);
  });

  test('excludes non-completed tasks', () => {
    const task = makeExecutionTask({ status: 'running' });
    expect(extractInsights([task])).toHaveLength(0);
  });
});

// ─── timeAgo ────────────────────────────────────────────────────

describe('timeAgo', () => {
  test('returns "just now" for recent dates', () => {
    expect(timeAgo(new Date())).toBe('just now');
  });

  test('returns minutes for < 1 hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000);
    expect(timeAgo(fiveMinAgo)).toBe('5m ago');
  });

  test('returns hours for < 24 hours', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600000);
    expect(timeAgo(threeHoursAgo)).toBe('3h ago');
  });

  test('returns days for >= 24 hours', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
    expect(timeAgo(twoDaysAgo)).toBe('2d ago');
  });

  test('accepts string dates', () => {
    const recent = new Date(Date.now() - 10 * 60000).toISOString();
    expect(timeAgo(recent)).toBe('10m ago');
  });
});
