/**
 * Unit tests for canUseTool background agent permission forwarding (SDK v0.3.186).
 *
 * Background agents now forward permission prompts to canUseTool instead of
 * auto-denying. The hook factory provides a createCanUseToolCallback that:
 * - For the main agent (no agentID): returns allow (hooks decide)
 * - For background subagents (agentID present): sets worker to waiting state
 *   and blocks until the user resolves the permission request
 *
 * agentID and requestId (v0.3.199) are used for multi-agent routing.
 *
 * Run: bun test apps/runner/__tests__/unit/can-use-tool-bg-agent.test.ts
 */

import { describe, test, expect, mock } from 'bun:test';
import { HookFactory } from '../../src/hook-factory';
import type { LocalWorker, Milestone } from '../../src/types';

function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  return {
    id: 'worker-1',
    taskId: 'task-1',
    taskTitle: 'Test task',
    workspaceId: 'ws-1',
    workspaceName: 'test',
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
    checkpoints: [],
    checkpointEvents: new Set(),
    phaseText: null,
    phaseStart: null,
    phaseToolCount: 0,
    phaseTools: [],
    ...overrides,
  };
}

const mockUpdateWorker = mock(async () => ({}));
const mockBuildd = { updateWorker: mockUpdateWorker } as any;
const mockAddMilestone = mock((_w: LocalWorker, _m: Milestone) => {});
const mockEmit = mock((_e: any) => {});

function makeFactory(pendingPermissionRequests = new Map<string, any>()) {
  return new HookFactory({
    config: {},
    buildd: mockBuildd,
    addMilestone: mockAddMilestone,
    emit: mockEmit,
    pendingPermissionRequests,
  });
}

const BASE_OPTIONS = {
  signal: new AbortController().signal,
  toolUseID: 'tool-use-1',
  requestId: 'req-1',
};

describe('createCanUseToolCallback', () => {
  describe('main agent (no agentID)', () => {
    test('allows without blocking when bypassPermissions=true', async () => {
      const worker = makeWorker();
      const factory = makeFactory();
      const cb = factory.createCanUseToolCallback(worker, true);

      const result = await cb('Bash', { command: 'ls' }, BASE_OPTIONS);

      expect(result?.behavior).toBe('allow');
      expect(worker.status).toBe('working');  // not set to waiting
    });

    test('allows (hooks decide) when bypassPermissions=false', async () => {
      const worker = makeWorker();
      const factory = makeFactory();
      const cb = factory.createCanUseToolCallback(worker, false);

      const result = await cb('Bash', { command: 'ls' }, BASE_OPTIONS);

      expect(result?.behavior).toBe('allow');
      expect(worker.status).toBe('working');
    });
  });

  describe('background subagent (agentID present)', () => {
    test('sets worker to waiting state when subagent requests permission', async () => {
      const pending = new Map<string, any>();
      const worker = makeWorker();
      const factory = makeFactory(pending);
      const cb = factory.createCanUseToolCallback(worker, false);

      const optsWithAgent = {
        ...BASE_OPTIONS,
        agentID: 'subagent-abc',
        title: 'Subagent wants to run Bash',
      };

      // Don't await — it blocks until resolved
      const promise = cb('Bash', { command: 'npm test' }, optsWithAgent);

      // Worker should now be waiting
      expect(worker.status).toBe('waiting');
      expect(worker.waitingFor?.type).toBe('permission');
      expect(worker.waitingFor?.toolName).toBe('Bash');

      // Pending request stored under worker.id
      expect(pending.has(worker.id)).toBe(true);
      const entry = pending.get(worker.id);
      expect(entry?.resolvePayloadType).toBe('canUseTool');

      // Resolve with allow
      entry.resolve({ behavior: 'allow' });
      const result = await promise;
      expect(result?.behavior).toBe('allow');
    });

    test('allow_always passes suggestions back as updatedPermissions', async () => {
      const pending = new Map<string, any>();
      const worker = makeWorker();
      const factory = makeFactory(pending);
      const cb = factory.createCanUseToolCallback(worker, false);

      const suggestions = [{ type: 'addRules', rules: [] }];
      const promise = cb('Bash', { command: 'git push' }, {
        ...BASE_OPTIONS,
        agentID: 'subagent-xyz',
        suggestions,
      });

      const entry = pending.get(worker.id);
      entry.resolve({ behavior: 'allow', updatedPermissions: suggestions });
      const result = await promise;
      expect(result?.behavior).toBe('allow');
      expect((result as any).updatedPermissions).toBe(suggestions);
    });

    test('deny returns deny result', async () => {
      const pending = new Map<string, any>();
      const worker = makeWorker();
      const factory = makeFactory(pending);
      const cb = factory.createCanUseToolCallback(worker, false);

      const promise = cb('Write', { file_path: '/etc/hosts' }, {
        ...BASE_OPTIONS,
        agentID: 'subagent-bad',
      });

      const entry = pending.get(worker.id);
      entry.resolve({ behavior: 'deny', message: 'Denied by user via runner' });
      const result = await promise;
      expect(result?.behavior).toBe('deny');
    });

    test('denies immediately when another permission request is already pending', async () => {
      const pending = new Map<string, any>();
      // Pre-seed a pending request for this worker
      pending.set('worker-1', { resolve: () => {}, toolInput: {}, suggestions: [] });

      const worker = makeWorker();
      const factory = makeFactory(pending);
      const cb = factory.createCanUseToolCallback(worker, false);

      const result = await cb('Bash', { command: 'rm -rf /' }, {
        ...BASE_OPTIONS,
        agentID: 'subagent-second',
      });

      // Should be denied immediately since there's already a pending request
      expect(result?.behavior).toBe('deny');
    });

    test('includes agentID in worker.currentAction', async () => {
      const pending = new Map<string, any>();
      const worker = makeWorker();
      const factory = makeFactory(pending);
      const cb = factory.createCanUseToolCallback(worker, false);

      const promise = cb('Read', { file_path: '/etc/passwd' }, {
        ...BASE_OPTIONS,
        agentID: 'agent-007',
      });

      expect(worker.currentAction).toContain('agent-007');

      const entry = pending.get(worker.id);
      entry.resolve({ behavior: 'deny', message: 'Denied' });
      await promise;
    });
  });
});
