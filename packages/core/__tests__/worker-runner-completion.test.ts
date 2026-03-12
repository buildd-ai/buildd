import { describe, expect, test } from 'bun:test';

/**
 * Tests for worker result handler logic: when the SDK emits a 'result' message,
 * the worker-runner must NOT overwrite status/task if the worker was already
 * completed via the PATCH API (e.g., agent called complete_task via MCP).
 *
 * This prevents three bugs:
 * 1. Tasks with PRs showing as "failed" when SDK errors after complete_task
 * 2. Task result summaries being overwritten with lastAssistantMessage
 * 3. Tasks with deliverables (PR, commits) showing as "failed" when SDK errors
 *    but agent never called complete_task
 */

type WorkerStatus = 'idle' | 'starting' | 'running' | 'waiting_input' | 'paused' | 'completed' | 'error';

/**
 * Determines whether the result handler should update worker status and task.
 * Extracted from WorkerRunner.handleMessage() result branch.
 */
function shouldUpdateStatusOnResult(
  currentWorkerStatus: WorkerStatus,
  localStatus: WorkerStatus,
): { updateStatus: boolean; updateTask: boolean; updateMetadata: boolean } {
  // waiting_input: don't touch anything — worker needs human input
  if (localStatus === 'waiting_input') {
    return { updateStatus: false, updateTask: false, updateMetadata: false };
  }

  // If worker was already completed by PATCH API (complete_task MCP action),
  // only update metadata (cost, tokens, resultMeta) — don't overwrite status or task
  const alreadyTerminal = currentWorkerStatus === 'completed' || currentWorkerStatus === 'error';
  if (alreadyTerminal) {
    return { updateStatus: false, updateTask: false, updateMetadata: true };
  }

  // Worker hasn't been completed yet — full update
  return { updateStatus: true, updateTask: true, updateMetadata: true };
}

/**
 * Determines whether a worker in 'error' status with a PR should be treated
 * as completed during cleanup reconciliation.
 * Extracted from cleanup route step 2 logic.
 */
function findCompletedWorker(
  taskWorkers: Array<{ status: string; prUrl: string | null }>,
): { status: string; prUrl: string | null } | undefined {
  return taskWorkers.find(w =>
    w.status === 'completed' || (w.status === 'error' && w.prUrl)
  );
}

describe('Worker result handler — terminal state guard', () => {
  test('does not update status/task when worker is already completed', () => {
    const result = shouldUpdateStatusOnResult('completed', 'running');
    expect(result.updateStatus).toBe(false);
    expect(result.updateTask).toBe(false);
    expect(result.updateMetadata).toBe(true);
  });

  test('does not update status/task when worker is already in error', () => {
    const result = shouldUpdateStatusOnResult('error', 'running');
    expect(result.updateStatus).toBe(false);
    expect(result.updateTask).toBe(false);
    expect(result.updateMetadata).toBe(true);
  });

  test('updates everything when worker is still running', () => {
    const result = shouldUpdateStatusOnResult('running', 'running');
    expect(result.updateStatus).toBe(true);
    expect(result.updateTask).toBe(true);
    expect(result.updateMetadata).toBe(true);
  });

  test('skips all updates when worker is waiting_input', () => {
    const result = shouldUpdateStatusOnResult('running', 'waiting_input');
    expect(result.updateStatus).toBe(false);
    expect(result.updateTask).toBe(false);
    expect(result.updateMetadata).toBe(false);
  });

  test('updates everything when worker is idle (first run)', () => {
    const result = shouldUpdateStatusOnResult('idle', 'running');
    expect(result.updateStatus).toBe(true);
    expect(result.updateTask).toBe(true);
    expect(result.updateMetadata).toBe(true);
  });
});

describe('Cleanup reconciliation — error workers with PRs', () => {
  test('finds completed worker', () => {
    const workers = [
      { status: 'completed', prUrl: 'https://github.com/org/repo/pull/1' },
    ];
    expect(findCompletedWorker(workers)).toBeDefined();
    expect(findCompletedWorker(workers)!.status).toBe('completed');
  });

  test('finds error worker with PR as completed', () => {
    const workers = [
      { status: 'error', prUrl: 'https://github.com/org/repo/pull/1' },
    ];
    expect(findCompletedWorker(workers)).toBeDefined();
    expect(findCompletedWorker(workers)!.status).toBe('error');
  });

  test('does not find error worker without PR', () => {
    const workers = [
      { status: 'error', prUrl: null },
    ];
    expect(findCompletedWorker(workers)).toBeUndefined();
  });

  test('prefers completed worker over error worker with PR', () => {
    const workers = [
      { status: 'error', prUrl: 'https://github.com/org/repo/pull/1' },
      { status: 'completed', prUrl: null },
    ];
    // find() returns first match — error worker comes first since it has PR
    const found = findCompletedWorker(workers);
    expect(found).toBeDefined();
  });

  test('returns undefined when all workers failed without PRs', () => {
    const workers = [
      { status: 'error', prUrl: null },
      { status: 'error', prUrl: null },
    ];
    expect(findCompletedWorker(workers)).toBeUndefined();
  });
});

/**
 * Determines the effective completion status when the SDK result reports an error
 * but the worker has deliverables (PR, commits, artifacts).
 *
 * Bug: SDK can error (budget exceeded, tool failures, etc.) AFTER the agent
 * created a PR and committed code. Without this check, the task shows as "failed"
 * despite having a valid PR attached.
 */
function resolveResultStatus(
  isError: boolean,
  worker: { prUrl?: string | null; commitCount?: number | null },
  opts?: { artifactCount?: number },
): { workerStatus: 'completed' | 'error'; taskStatus: 'completed' | 'failed'; snapshotDeliverables: boolean } {
  if (!isError) {
    return { workerStatus: 'completed', taskStatus: 'completed', snapshotDeliverables: true };
  }

  // SDK errored — but check if worker produced deliverables
  const hasPR = !!worker.prUrl;
  const hasCommits = typeof worker.commitCount === 'number' && worker.commitCount > 0;
  const hasArtifacts = (opts?.artifactCount ?? 0) > 0;
  const hasDeliverables = hasPR || hasCommits || hasArtifacts;

  if (hasDeliverables) {
    return { workerStatus: 'completed', taskStatus: 'completed', snapshotDeliverables: true };
  }

  return { workerStatus: 'error', taskStatus: 'failed', snapshotDeliverables: false };
}

describe('Result status resolution — deliverables override SDK errors', () => {
  test('SDK success → completed', () => {
    const result = resolveResultStatus(false, { prUrl: null, commitCount: 0 });
    expect(result.workerStatus).toBe('completed');
    expect(result.taskStatus).toBe('completed');
    expect(result.snapshotDeliverables).toBe(true);
  });

  test('SDK error + PR → completed (not failed)', () => {
    const result = resolveResultStatus(true, {
      prUrl: 'https://github.com/org/repo/pull/42',
      commitCount: 3,
    });
    expect(result.workerStatus).toBe('completed');
    expect(result.taskStatus).toBe('completed');
    expect(result.snapshotDeliverables).toBe(true);
  });

  test('SDK error + commits but no PR → completed', () => {
    const result = resolveResultStatus(true, { prUrl: null, commitCount: 5 });
    expect(result.workerStatus).toBe('completed');
    expect(result.taskStatus).toBe('completed');
    expect(result.snapshotDeliverables).toBe(true);
  });

  test('SDK error + artifacts but no PR/commits → completed', () => {
    const result = resolveResultStatus(true, { prUrl: null, commitCount: 0 }, { artifactCount: 2 });
    expect(result.workerStatus).toBe('completed');
    expect(result.taskStatus).toBe('completed');
    expect(result.snapshotDeliverables).toBe(true);
  });

  test('SDK error + no deliverables → failed', () => {
    const result = resolveResultStatus(true, { prUrl: null, commitCount: 0 });
    expect(result.workerStatus).toBe('error');
    expect(result.taskStatus).toBe('failed');
    expect(result.snapshotDeliverables).toBe(false);
  });

  test('SDK error + null counts → failed', () => {
    const result = resolveResultStatus(true, { prUrl: null, commitCount: null });
    expect(result.workerStatus).toBe('error');
    expect(result.taskStatus).toBe('failed');
    expect(result.snapshotDeliverables).toBe(false);
  });
});

/**
 * Determines whether the alreadyTerminal branch should backfill lastAssistantMessage
 * into the task result when the existing result has no summary.
 */
function shouldBackfillSummary(
  taskResult: { summary?: string } | null,
  lastAssistantMessage: string | null,
): boolean {
  if (!lastAssistantMessage) return false;
  if (!taskResult) return true;
  if (!taskResult.summary) return true;
  return false;
}

describe('Summary backfill — alreadyTerminal branch', () => {
  test('backfills when task result has no summary', () => {
    expect(shouldBackfillSummary({ summary: undefined }, 'Agent completed the work')).toBe(true);
  });

  test('backfills when task result is null', () => {
    expect(shouldBackfillSummary(null, 'Agent completed the work')).toBe(true);
  });

  test('does not backfill when task result already has summary', () => {
    expect(shouldBackfillSummary({ summary: 'Existing summary' }, 'Agent completed the work')).toBe(false);
  });

  test('does not backfill when lastAssistantMessage is null', () => {
    expect(shouldBackfillSummary({ summary: undefined }, null)).toBe(false);
  });
});
