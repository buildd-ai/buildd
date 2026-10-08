/**
 * Unit tests for the PreToolUse path-claim hook (§6c of path-claims.md,
 * §2 of conflict-aware-orchestration.md).
 *
 * Covers:
 *  - Path extraction and worktree-relative normalization; escapes never claimed
 *  - Advisory mode (default): a 409 never blocks the edit
 *  - Enforce mode: a confirmed live holder denies the edit, naming task and path
 *  - Bounded network deadline: a hung or failing service never freezes the
 *    session, queues the path and records degraded enforcement
 *  - Per-path pending queues: a denied path is never cleared as if acquired,
 *    queued paths flush in their own request, and a queued path the server now
 *    reports held is a checkpoint collision (it was already written)
 *  - Once a collision is recorded, further edits are refused
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/path-claim-hook.test.ts
 */

import { describe, test, expect, mock } from 'bun:test';

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

import { HookFactory, PATH_CLAIM_HOOK_DEADLINE_MS } from '../../src/hook-factory';
import { PATH_CLAIM_TIMEOUT_MS } from '../../src/path-claim-enforcement';
import type { PathClaimResponse } from '../../src/buildd';
import type { LocalWorker } from '../../src/types';
import { RUNNER_DENIAL_MARKER } from '../../src/runner-denial';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROOT = '/work/tree';
const BLOCKER = 'bbbbbbbb-1111-2222-3333-444444444444';

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
    worktreePath: ROOT,
    ...overrides,
  } as unknown as LocalWorker;
}

const CLAIMED: PathClaimResponse = { kind: 'claimed' };
const conflict = (path: string, blockingPath = path): PathClaimResponse => ({
  kind: 'conflict',
  blockingTaskId: BLOCKER,
  blockingTaskTitle: 'Other task',
  blockingPath,
  blocked: [{ path, blockingTaskId: BLOCKER, blockingPath }],
});
const UNAVAILABLE: PathClaimResponse = { kind: 'unavailable', reason: 'timeout' };

function makeFactory(respond: (paths: string[]) => Promise<PathClaimResponse> | PathClaimResponse) {
  const claimPaths = mock(async (_taskId: string, paths: string[]) => respond(paths));
  const milestones: any[] = [];
  const collisions: any[] = [];
  const factory = new HookFactory({
    config: {},
    buildd: { claimPaths } as any,
    addMilestone: (_w, m) => { milestones.push(m); },
    emit: () => {},
    pendingPermissionRequests: new Map(),
    onPathCollision: (_w, c) => { collisions.push(c); },
  });
  return { factory, claimPaths, milestones, collisions };
}

function makeInput(toolName: string, toolInput: Record<string, unknown>) {
  return { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput };
}

const isDeny = (r: any) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const reasonOf = (r: any) => String(r?.hookSpecificOutput?.permissionDecisionReason ?? '');

// ─── Extraction + normalization ──────────────────────────────────────────────

describe('createPathClaimHook — path extraction and normalization', () => {
  test('Edit: absolute worktree path is claimed worktree-relative', async () => {
    const { factory, claimPaths } = makeFactory(() => CLAIMED);
    const hook = factory.createPathClaimHook(makeWorker());

    await hook(makeInput('Edit', { file_path: `${ROOT}/apps/web/src/foo.ts` }) as any);

    expect(claimPaths).toHaveBeenCalledTimes(1);
    expect(claimPaths).toHaveBeenCalledWith('task-abc', ['apps/web/src/foo.ts']);
  });

  test('Write: relative path claimed as-is', async () => {
    const { factory, claimPaths } = makeFactory(() => CLAIMED);
    const hook = factory.createPathClaimHook(makeWorker());

    await hook(makeInput('Write', { file_path: 'packages/core/src/bar.ts' }) as any);

    expect(claimPaths).toHaveBeenCalledWith('task-abc', ['packages/core/src/bar.ts']);
  });

  test('MultiEdit: top-level file_path and per-edit paths, deduped', async () => {
    const { factory, claimPaths } = makeFactory(() => CLAIMED);
    const hook = factory.createPathClaimHook(makeWorker());

    await hook(makeInput('MultiEdit', {
      edits: [
        { file_path: 'apps/web/a.ts', old_string: 'x', new_string: 'y' },
        { file_path: 'apps/web/b.ts', old_string: 'x', new_string: 'y' },
        { file_path: 'apps/web/a.ts', old_string: 'p', new_string: 'q' },
      ],
    }) as any);

    expect(claimPaths).toHaveBeenCalledTimes(1);
    expect(claimPaths.mock.calls[0][1]).toEqual(['apps/web/a.ts', 'apps/web/b.ts']);
  });

  test('an escape path is never sent as a claim (advisory: edit left to the confinement hook)', async () => {
    const { factory, claimPaths } = makeFactory(() => CLAIMED);
    const hook = factory.createPathClaimHook(makeWorker());

    const result = await hook(makeInput('Edit', { file_path: '/work/other-tree/x.ts' }) as any);

    expect(claimPaths).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  test('enforce: an escape path is denied and named', async () => {
    const { factory, claimPaths } = makeFactory(() => CLAIMED);
    const hook = factory.createPathClaimHook(makeWorker({ pathClaimMode: 'enforce' } as any));

    const result = await hook(makeInput('Write', { file_path: '../escape.ts' }) as any);

    expect(claimPaths).not.toHaveBeenCalled();
    expect(isDeny(result)).toBe(true);
    expect(reasonOf(result)).toContain('../escape.ts');
    expect(reasonOf(result)).toContain(RUNNER_DENIAL_MARKER);
  });

  test('runtime scratch paths are not claimed', async () => {
    const { factory, claimPaths } = makeFactory(() => CLAIMED);
    const hook = factory.createPathClaimHook(makeWorker());

    await hook(makeInput('Write', { file_path: `${ROOT}/.buildd/notes.json` }) as any);

    expect(claimPaths).not.toHaveBeenCalled();
  });

  test('Read and Bash are ignored', async () => {
    const { factory, claimPaths } = makeFactory(() => CLAIMED);
    const hook = factory.createPathClaimHook(makeWorker({ pathClaimMode: 'enforce' } as any));

    await hook(makeInput('Read', { file_path: 'apps/web/src/foo.ts' }) as any);
    await hook(makeInput('Bash', { command: 'echo hi > a.ts' }) as any);

    expect(claimPaths).not.toHaveBeenCalled();
  });
});

// ─── Advisory vs enforce ─────────────────────────────────────────────────────

describe('createPathClaimHook — advisory (default) never blocks', () => {
  test('a clean claim allows the edit', async () => {
    const { factory } = makeFactory(() => CLAIMED);
    const result = await factory.createPathClaimHook(makeWorker())(makeInput('Edit', { file_path: 'foo.ts' }) as any);
    expect(result).toEqual({});
  });

  test('a confirmed 409 still allows the edit and queues nothing', async () => {
    const { factory } = makeFactory(() => conflict('foo.ts'));
    const worker = makeWorker();
    const result = await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'foo.ts' }) as any);
    expect(result).toEqual({});
    expect(worker.pendingPaths ?? []).toEqual([]);
  });
});

describe('createPathClaimHook — enforce denies confirmed holders', () => {
  test('a confirmed live holder denies the edit, naming the blocking task and path', async () => {
    const { factory } = makeFactory(() => conflict('apps/web/a.ts', 'apps/web'));
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);

    const result = await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/web/a.ts' }) as any);

    expect(isDeny(result)).toBe(true);
    const reason = reasonOf(result);
    expect(reason).toContain(RUNNER_DENIAL_MARKER);
    expect(reason).toContain('apps/web/a.ts');
    expect(reason).toContain('bbbbbbbb');
    expect(reason).toContain('Other task');
    expect(reason).toContain('apps/web');
  });

  test('a denied path is not queued as if it had been written or acquired', async () => {
    const { factory } = makeFactory(() => conflict('apps/web/a.ts'));
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);

    await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/web/a.ts' }) as any);

    expect(worker.pendingPaths ?? []).toEqual([]);
    // A pre-edit denial is not a collision: nothing was written.
    expect((worker as any).pathCollision).toBeUndefined();
  });

  test('a clean claim in enforce mode allows the edit', async () => {
    const { factory } = makeFactory(() => CLAIMED);
    const result = await factory.createPathClaimHook(makeWorker({ pathClaimMode: 'enforce' } as any))(makeInput('Write', { file_path: 'a.ts' }) as any);
    expect(result).toEqual({});
  });

  test('after a recorded collision every further edit is refused without a network call', async () => {
    const { factory, claimPaths } = makeFactory(() => CLAIMED);
    const worker = makeWorker({
      pathClaimMode: 'enforce',
      pathCollision: { path: 'x.ts', blockingTaskId: BLOCKER, source: 'sync', detectedAt: 1 },
    } as any);

    const result = await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'other.ts' }) as any);

    expect(isDeny(result)).toBe(true);
    expect(reasonOf(result)).toContain('x.ts');
    expect(claimPaths).not.toHaveBeenCalled();
  });
});

// ─── Network deadline / fail-open ────────────────────────────────────────────

describe('createPathClaimHook — bounded network deadline', () => {
  test('a hung service does not freeze the session: the hook returns within its deadline', async () => {
    const { factory, milestones } = makeFactory(() => new Promise<PathClaimResponse>(() => {}));
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);

    const started = Date.now();
    const result = await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/web/src/foo.ts' }) as any);
    const elapsed = Date.now() - started;

    expect(result).toEqual({});
    expect(elapsed).toBeLessThan(PATH_CLAIM_HOOK_DEADLINE_MS + 250);
    expect(worker.pendingPaths).toEqual(['apps/web/src/foo.ts']);
    expect((worker as any).pathClaimDegraded).toBe(1);
    expect(milestones.some(m => String(m.label).toLowerCase().includes('degraded'))).toBe(true);
  });

  // Production round trips run ~75-425ms even for a cheap 401. A 200ms client
  // timeout called real successes "unavailable" and dropped real 409s.
  const SLOW_BUT_HEALTHY_MS = 450;
  const after = <T,>(ms: number, v: T) => new Promise<T>(r => setTimeout(() => r(v), ms));

  test('a claim answered after 200ms (but within the deadline) is consumed, not reported degraded', async () => {
    expect(SLOW_BUT_HEALTHY_MS).toBeLessThan(PATH_CLAIM_HOOK_DEADLINE_MS);
    const { factory, milestones } = makeFactory(() => after(SLOW_BUT_HEALTHY_MS, CLAIMED));
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);

    const result = await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/web/src/foo.ts' }) as any);

    expect(result).toEqual({});
    expect(worker.pendingPaths ?? []).toEqual([]);
    expect((worker as any).pathClaimDegraded ?? 0).toBe(0);
    expect(milestones.some(m => String(m.label).toLowerCase().includes('degraded'))).toBe(false);
  });

  test('enforce: a 409 answered after 200ms is still honored — the edit is denied, not failed open', async () => {
    const { factory } = makeFactory(() => after(SLOW_BUT_HEALTHY_MS, conflict('apps/web/src/foo.ts')));
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);

    const result = await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/web/src/foo.ts' }) as any);

    expect(isDeny(result)).toBe(true);
    expect(reasonOf(result)).toContain('apps/web/src/foo.ts is being edited by');
    expect(worker.pendingPaths ?? []).toEqual([]);
    expect((worker as any).pathClaimDegraded ?? 0).toBe(0);
  });

  test('the hook backstop never fires before the client request timeout', () => {
    expect(PATH_CLAIM_HOOK_DEADLINE_MS).toBeGreaterThan(PATH_CLAIM_TIMEOUT_MS);
  });

  test('unavailable (timeout/network/5xx) queues the path and allows the edit, even when enforcing', async () => {
    const { factory } = makeFactory(() => UNAVAILABLE);
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);

    const result = await factory.createPathClaimHook(worker)(makeInput('Write', { file_path: 'src/index.ts' }) as any);

    expect(result).toEqual({});
    expect(worker.pendingPaths).toEqual(['src/index.ts']);
  });

  test('a thrown client error is treated as unavailable', async () => {
    const { factory } = makeFactory(() => { throw new Error('unexpected'); });
    const worker = makeWorker();
    const result = await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'foo.ts' }) as any);
    expect(result).toEqual({});
    expect(worker.pendingPaths).toContain('foo.ts');
  });

  test('the pending queue is bounded', async () => {
    const { factory } = makeFactory(() => UNAVAILABLE);
    const worker = makeWorker({ pendingPaths: Array.from({ length: 600 }, (_, i) => `p${i}.ts`) } as any);
    await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'new.ts' }) as any);
    expect(worker.pendingPaths!.length).toBeLessThanOrEqual(500);
    expect(worker.pendingPaths).toContain('new.ts');
  });
});

// ─── Per-path pending queue ──────────────────────────────────────────────────

describe('createPathClaimHook — per-path pending queue', () => {
  test('queued paths flush in their own request, so a held queued path cannot deny a free edit', async () => {
    const { factory, claimPaths } = makeFactory((paths) =>
      paths.includes('apps/old/a.ts') ? conflict('apps/old/a.ts') : CLAIMED,
    );
    const worker = makeWorker({ pendingPaths: ['apps/old/a.ts'] } as any);

    const result = await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/new/c.ts' }) as any);

    expect(result).toEqual({});
    expect(claimPaths).toHaveBeenCalledTimes(2);
    const batches = claimPaths.mock.calls.map(c => c[1]);
    expect(batches).toContainEqual(['apps/new/c.ts']);
    expect(batches).toContainEqual(['apps/old/a.ts']);
  });

  test('a successful flush clears only the flushed paths', async () => {
    const { factory } = makeFactory(() => CLAIMED);
    const worker = makeWorker({ pendingPaths: ['apps/old/a.ts', 'apps/old/b.ts'] } as any);

    await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/new/c.ts' }) as any);

    expect(worker.pendingPaths).toEqual([]);
  });

  test('advisory: a queued path now held elsewhere is dropped; the free ones stay queued (all-or-nothing granted nothing)', async () => {
    const { factory, collisions } = makeFactory((paths) =>
      paths.includes('apps/old/a.ts') ? conflict('apps/old/a.ts') : CLAIMED,
    );
    const worker = makeWorker({ pendingPaths: ['apps/old/a.ts', 'apps/old/b.ts'] } as any);

    await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/new/c.ts' }) as any);

    expect(worker.pendingPaths).toEqual(['apps/old/b.ts']);
    expect(collisions).toEqual([]);
  });

  test('enforce: a queued (already written) path now held elsewhere is a collision, and the edit is refused', async () => {
    const { factory, collisions } = makeFactory((paths) =>
      paths.includes('apps/old/a.ts') ? conflict('apps/old/a.ts') : CLAIMED,
    );
    const worker = makeWorker({ pathClaimMode: 'enforce', pendingPaths: ['apps/old/a.ts'] } as any);

    const result = await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/new/c.ts' }) as any);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ path: 'apps/old/a.ts', blockingTaskId: BLOCKER, source: 'hook_flush' });
    expect((worker as any).pathCollision).toMatchObject({ path: 'apps/old/a.ts' });
    expect(isDeny(result)).toBe(true);
  });

  test('a failed flush keeps every queued path and adds the new one', async () => {
    const { factory } = makeFactory(() => UNAVAILABLE);
    const worker = makeWorker({ pendingPaths: ['apps/old/a.ts'] } as any);

    await factory.createPathClaimHook(worker)(makeInput('Edit', { file_path: 'apps/new/c.ts' }) as any);

    expect(worker.pendingPaths).toContain('apps/old/a.ts');
    expect(worker.pendingPaths).toContain('apps/new/c.ts');
  });
});

// ─── Checkpoint guard: Bash push, create_pr, completion ──────────────────────

describe('createPathCheckpointGuardHook — ship checkpoint, fail closed', () => {
  const held = { path: 'src/from-bash.ts', blockingTaskId: BLOCKER, blockingTaskTitle: 'Other task', blockingPath: 'src', source: 'pre_push' as const, detectedAt: 1 };
  const COMPLETE = { kind: 'complete' as const, generation: 1, heldCount: 1 };
  const BLOCKED = { kind: 'blocked' as const, collision: held, blocked: [held] };
  const UNKNOWN = { kind: 'unknown' as const, cause: 'timeout' as const, attempts: 3 };

  function guard(worker: LocalWorker, result: any) {
    const { factory, collisions, milestones } = makeFactory(() => CLAIMED);
    const checkpoint = mock(async () => (typeof result === 'function' ? result() : result));
    return { hook: factory.createPathCheckpointGuardHook(worker, checkpoint as any), checkpoint, collisions, milestones };
  }

  test('advisory: the checkpoint still runs (its leases protect siblings) but never blocks', async () => {
    const worker = makeWorker();
    const { hook, checkpoint } = guard(worker, BLOCKED);
    expect(await hook(makeInput('Bash', { command: 'git push origin HEAD' }) as any)).toEqual({});
    expect(checkpoint).toHaveBeenCalledWith(worker, 'pre_push');
    expect((worker as any).pathCollision).toBeUndefined();
  });

  test('advisory: unknown coverage is recorded for the server and let through', async () => {
    const worker = makeWorker();
    const { hook, milestones } = guard(worker, UNKNOWN);
    expect(await hook(makeInput('Bash', { command: 'git push' }) as any)).toEqual({});
    expect((worker as any).pendingShipReports).toEqual([expect.objectContaining({ source: 'pre_push', result: 'unknown', cause: 'timeout', refused: false, attempts: 3 })]);
    expect(milestones.some(m => String(m.label).includes('coverage unknown'))).toBe(true);
  });

  test('enforce: a Bash write found at pre-push refuses the push and starts the deferral', async () => {
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);
    const { hook, checkpoint, collisions } = guard(worker, BLOCKED);

    const result = await hook(makeInput('Bash', { command: 'git push -u origin HEAD' }) as any);

    expect(checkpoint).toHaveBeenCalledWith(worker, 'pre_push');
    expect(isDeny(result)).toBe(true);
    expect(reasonOf(result)).toContain('src/from-bash.ts');
    expect(reasonOf(result)).toContain('bbbbbbbb');
    expect(collisions).toHaveLength(1);
    expect((worker as any).pathCollision).toMatchObject({ path: 'src/from-bash.ts' });
  });

  test('enforce: create_pr and a non-error complete_task are checkpoints too', async () => {
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);
    const { hook, checkpoint } = guard(worker, COMPLETE);
    await hook(makeInput('mcp__buildd__buildd', { action: 'create_pr', params: {} }) as any);
    await hook(makeInput('mcp__buildd__buildd', { action: 'complete_task', params: { summary: 'x' } }) as any);
    expect(checkpoint.mock.calls.map((c: any[]) => c[1])).toEqual(['pre_push', 'completion']);
  });

  test('enforce: create_pr and complete_task on the group tool buildd_work are checkpoints', async () => {
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);
    const { hook, checkpoint } = guard(worker, COMPLETE);
    await hook(makeInput('mcp__buildd__buildd_work', { action: 'create_pr', params: {} }) as any);
    await hook(makeInput('mcp__buildd__buildd_work', { action: 'complete_task', params: { summary: 'x' } }) as any);
    expect(checkpoint.mock.calls.map((c: any[]) => c[1])).toEqual(['pre_push', 'completion']);
  });

  test('a failure report (complete_task with error) and ordinary Bash are not gated', async () => {
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);
    const { hook, checkpoint } = guard(worker, BLOCKED);
    expect(await hook(makeInput('mcp__buildd__buildd', { action: 'complete_task', params: { error: 'gave up' } }) as any)).toEqual({});
    expect(await hook(makeInput('Bash', { command: 'bun run test' }) as any)).toEqual({});
    expect(checkpoint).not.toHaveBeenCalled();
  });

  test('enforce: proven coverage lets the push through', async () => {
    const { hook } = guard(makeWorker({ pathClaimMode: 'enforce' } as any), COMPLETE);
    expect(await hook(makeInput('Bash', { command: 'git push' }) as any)).toEqual({});
  });

  test('enforce: coverage the coordinator could not confirm REFUSES the ship — fail closed, no deferral, retryable', async () => {
    const worker = makeWorker({ pathClaimMode: 'enforce' } as any);
    const { hook, collisions, milestones } = guard(worker, UNKNOWN);
    const result = await hook(makeInput('mcp__buildd__buildd', { action: 'create_pr', params: {} }) as any);
    expect(isDeny(result)).toBe(true);
    expect(reasonOf(result)).toMatch(/could not confirm/);
    expect(reasonOf(result)).toMatch(/retry/);
    // Not a collision: nothing to defer behind, the agent simply tries again.
    expect(collisions).toHaveLength(0);
    expect((worker as any).pathCollision).toBeUndefined();
    expect((worker as any).pendingShipReports).toEqual([expect.objectContaining({ source: 'pre_push', refused: true, cause: 'timeout' })]);
    // The milestone is coalesced per cause.
    await hook(makeInput('mcp__buildd__buildd', { action: 'create_pr', params: {} }) as any);
    expect(milestones.filter(m => String(m.label).includes('coverage unknown'))).toHaveLength(1);
    expect((worker as any).pendingShipReports).toHaveLength(2);
  });

  test('enforce: a checkpoint that throws proved nothing and refuses the ship', async () => {
    const { hook } = guard(makeWorker({ pathClaimMode: 'enforce' } as any), () => { throw new Error('git broke'); });
    const result = await hook(makeInput('Bash', { command: 'git push' }) as any);
    expect(isDeny(result)).toBe(true);
    expect(reasonOf(result)).toContain('git broke');
  });

  test('enforce: once a collision is recorded, push and completion are refused without another checkpoint', async () => {
    const worker = makeWorker({ pathClaimMode: 'enforce', pathCollision: held } as any);
    const { hook, checkpoint } = guard(worker, COMPLETE);
    expect(isDeny(await hook(makeInput('Bash', { command: 'git push' }) as any))).toBe(true);
    expect(isDeny(await hook(makeInput('mcp__buildd__buildd', { action: 'complete_task', params: {} }) as any))).toBe(true);
    expect(checkpoint).not.toHaveBeenCalled();
  });
});
