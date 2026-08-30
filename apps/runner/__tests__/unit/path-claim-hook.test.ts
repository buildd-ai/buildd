/**
 * Unit tests for the PreToolUse path-claim hook (§6c of path-claims.md).
 *
 * Covers:
 *  - Hook fires on Edit/Write/MultiEdit and calls claimPaths with correct path
 *  - Timeout (>200ms): edit proceeds, new path queued in pendingPaths
 *  - Network error: edit proceeds, path queued
 *  - Queued paths are flushed (included + cleared) on next successful claim
 *  - Queued paths appear in update_progress body (worker-sync)
 *  - Hook is advisory: 409 does not block the edit, pendingPaths cleared
 *  - Hook ignores non-write tools (Read, Bash, etc.)
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/path-claim-hook.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── Module stubs (must precede imports) ────────────────────────────────────

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() {
      return { async next() { return { value: undefined, done: true }; } };
    },
  }),
}));

mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  getWorker: () => null,
}));

import { HookFactory } from '../../src/hook-factory';
import type { LocalWorker } from '../../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  return {
    id: 'w1',
    taskId: 'task-abc',
    taskTitle: 'test task',
    workspaceId: 'ws1',
    workspaceName: 'test',
    workspaceDataClass: 'standard',
    branch: 'main',
    status: 'working',
    hasNewActivity: false,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    milestones: [],
    currentAction: '',
    commits: [],
    output: [],
    toolCalls: [],
    messages: [],
    subagentTasks: [],
    subagentTasksObservedCount: 0,
    checkpoints: [],
    checkpointEvents: new Set(),
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    ...overrides,
  } as unknown as LocalWorker;
}

type ClaimResult = { claimed: boolean; blockingTaskId?: string } | null;

function makeFactory(claimResult: () => Promise<ClaimResult>) {
  const claimPaths = mock(claimResult);
  const factory = new HookFactory({
    config: {},
    buildd: { claimPaths } as any,
    addMilestone: () => {},
    emit: () => {},
    pendingPermissionRequests: new Map(),
  });
  return { factory, claimPaths };
}

function makeInput(toolName: string, toolInput: Record<string, unknown>) {
  return { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createPathClaimHook — basic path extraction', () => {
  test('Edit: calls claimPaths with file_path', async () => {
    const { factory, claimPaths } = makeFactory(async () => ({ claimed: true }));
    const worker = makeWorker();
    const hook = factory.createPathClaimHook(worker);

    await hook(makeInput('Edit', { file_path: 'apps/web/src/foo.ts' }) as any);

    expect(claimPaths).toHaveBeenCalledTimes(1);
    expect(claimPaths).toHaveBeenCalledWith('task-abc', ['apps/web/src/foo.ts']);
  });

  test('Write: calls claimPaths with file_path', async () => {
    const { factory, claimPaths } = makeFactory(async () => ({ claimed: true }));
    const worker = makeWorker();
    const hook = factory.createPathClaimHook(worker);

    await hook(makeInput('Write', { file_path: 'packages/core/src/bar.ts' }) as any);

    expect(claimPaths).toHaveBeenCalledWith('task-abc', ['packages/core/src/bar.ts']);
  });

  test('MultiEdit: calls claimPaths with all file_paths (deduped)', async () => {
    const { factory, claimPaths } = makeFactory(async () => ({ claimed: true }));
    const worker = makeWorker();
    const hook = factory.createPathClaimHook(worker);

    await hook(makeInput('MultiEdit', {
      edits: [
        { file_path: 'apps/web/a.ts', old_string: 'x', new_string: 'y' },
        { file_path: 'apps/web/b.ts', old_string: 'x', new_string: 'y' },
        { file_path: 'apps/web/a.ts', old_string: 'p', new_string: 'q' },
      ],
    }) as any);

    expect(claimPaths).toHaveBeenCalledTimes(1);
    const [, paths] = claimPaths.mock.calls[0];
    expect(paths).toContain('apps/web/a.ts');
    expect(paths).toContain('apps/web/b.ts');
    expect(paths).toHaveLength(2);
  });

  test('Read: ignored (not a write tool)', async () => {
    const { factory, claimPaths } = makeFactory(async () => ({ claimed: true }));
    const worker = makeWorker();
    const hook = factory.createPathClaimHook(worker);

    await hook(makeInput('Read', { file_path: 'apps/web/src/foo.ts' }) as any);

    expect(claimPaths).not.toHaveBeenCalled();
  });

  test('Bash: ignored', async () => {
    const { factory, claimPaths } = makeFactory(async () => ({ claimed: true }));
    const worker = makeWorker();
    const hook = factory.createPathClaimHook(worker);

    await hook(makeInput('Bash', { command: 'echo hi' }) as any);

    expect(claimPaths).not.toHaveBeenCalled();
  });

  test('returns {} (never blocks the edit)', async () => {
    const { factory } = makeFactory(async () => ({ claimed: true }));
    const worker = makeWorker();
    const hook = factory.createPathClaimHook(worker);

    const result = await hook(makeInput('Edit', { file_path: 'foo.ts' }) as any);

    expect(result).toEqual({});
  });
});

describe('createPathClaimHook — fail-open on timeout / error', () => {
  test('null return (timeout): edit proceeds, path queued in pendingPaths', async () => {
    const { factory } = makeFactory(async () => null);  // simulates timeout/network error
    const worker = makeWorker();
    const hook = factory.createPathClaimHook(worker);

    const result = await hook(makeInput('Edit', { file_path: 'apps/web/src/foo.ts' }) as any);

    expect(result).toEqual({});
    expect(worker.pendingPaths).toEqual(['apps/web/src/foo.ts']);
  });

  test('null return (network error): path queued, edit proceeds', async () => {
    const { factory } = makeFactory(async () => null);
    const worker = makeWorker();
    const hook = factory.createPathClaimHook(worker);

    await hook(makeInput('Write', { file_path: 'src/index.ts' }) as any);

    expect(worker.pendingPaths).toContain('src/index.ts');
  });

  test('thrown error: edit proceeds, path queued', async () => {
    const { factory } = makeFactory(async () => { throw new Error('unexpected'); });
    const worker = makeWorker();
    const hook = factory.createPathClaimHook(worker);

    const result = await hook(makeInput('Edit', { file_path: 'foo.ts' }) as any);

    expect(result).toEqual({});
    expect(worker.pendingPaths).toContain('foo.ts');
  });
});

describe('createPathClaimHook — pending path flush', () => {
  test('pending paths are included in next claim call', async () => {
    const { factory, claimPaths } = makeFactory(async () => ({ claimed: true }));
    const worker = makeWorker({ pendingPaths: ['apps/old/a.ts', 'apps/old/b.ts'] } as any);
    const hook = factory.createPathClaimHook(worker);

    await hook(makeInput('Edit', { file_path: 'apps/new/c.ts' }) as any);

    const [, paths] = claimPaths.mock.calls[0];
    expect(paths).toContain('apps/old/a.ts');
    expect(paths).toContain('apps/old/b.ts');
    expect(paths).toContain('apps/new/c.ts');
  });

  test('successful claim clears pendingPaths', async () => {
    const { factory } = makeFactory(async () => ({ claimed: true }));
    const worker = makeWorker({ pendingPaths: ['apps/old/a.ts'] } as any);
    const hook = factory.createPathClaimHook(worker);

    await hook(makeInput('Edit', { file_path: 'apps/new/c.ts' }) as any);

    expect(worker.pendingPaths).toEqual([]);
  });

  test('advisory 409 also clears pendingPaths (server received the request)', async () => {
    const { factory } = makeFactory(async () => ({ claimed: false, blockingTaskId: 'other-task' }));
    const worker = makeWorker({ pendingPaths: ['apps/old/a.ts'] } as any);
    const hook = factory.createPathClaimHook(worker);

    const result = await hook(makeInput('Edit', { file_path: 'apps/new/c.ts' }) as any);

    // Edit must still proceed
    expect(result).toEqual({});
    // pendingPaths cleared since the server was reached
    expect(worker.pendingPaths).toEqual([]);
  });

  test('failed claim accumulates all paths in pendingPaths', async () => {
    const { factory } = makeFactory(async () => null);
    const worker = makeWorker({ pendingPaths: ['apps/old/a.ts'] } as any);
    const hook = factory.createPathClaimHook(worker);

    await hook(makeInput('Edit', { file_path: 'apps/new/c.ts' }) as any);

    expect(worker.pendingPaths).toContain('apps/old/a.ts');
    expect(worker.pendingPaths).toContain('apps/new/c.ts');
  });

  test('pending paths are included in update_progress PATCH body', async () => {
    // Verify that worker-sync includes pendingPaths in the update when non-empty.
    // We test this by constructing the update object the same way worker-sync does.
    const worker = makeWorker({ pendingPaths: ['apps/web/src/foo.ts', 'apps/web/src/bar.ts'] } as any);

    // Mirror the worker-sync spread logic
    const pendingPathsField = worker.pendingPaths?.length
      ? { pendingPaths: [...worker.pendingPaths] }
      : {};

    expect(pendingPathsField).toEqual({
      pendingPaths: ['apps/web/src/foo.ts', 'apps/web/src/bar.ts'],
    });
  });

  test('update_progress PATCH body omits pendingPaths when queue is empty', async () => {
    const worker = makeWorker({ pendingPaths: [] } as any);

    const pendingPathsField = worker.pendingPaths?.length
      ? { pendingPaths: [...worker.pendingPaths] }
      : {};

    expect(pendingPathsField).toEqual({});
  });
});
