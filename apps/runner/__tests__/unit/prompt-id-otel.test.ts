/**
 * Unit tests for prompt_id OTEL trace correlation (SDK v0.3.196).
 *
 * prompt_id is present on BaseHookInput and correlates all hook events within
 * a single user prompt turn to OTel spans emitted by the SDK (attribute: prompt.id).
 * Hooks extract it and store it on worker.currentPromptId so runner logs can be
 * joined to SDK OTel events.
 *
 * Run: bun test apps/runner/__tests__/unit/prompt-id-otel.test.ts
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

const mockBuildd = { updateWorker: mock(async () => ({})) } as any;
const mockAddMilestone = mock((_w: LocalWorker, _m: Milestone) => {});
const mockEmit = mock((_e: any) => {});

function makeFactory() {
  return new HookFactory({
    config: {},
    buildd: mockBuildd,
    addMilestone: mockAddMilestone,
    emit: mockEmit,
    pendingPermissionRequests: new Map(),
  });
}

describe('prompt_id OTEL correlation', () => {
  test('permission hook captures prompt_id on worker', async () => {
    const worker = makeWorker();
    const factory = makeFactory();
    const hook = factory.createPermissionHook(worker);

    await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      prompt_id: 'prompt-abc-123',
    });

    expect(worker.currentPromptId).toBe('prompt-abc-123');
  });

  test('stop hook captures prompt_id on worker', async () => {
    const worker = makeWorker();
    const factory = makeFactory();
    const hook = factory.createStopHook(worker);

    await hook({
      hook_event_name: 'Stop',
      last_assistant_message: 'Done.',
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      prompt_id: 'prompt-xyz-999',
      stop_hook_active: false,
    });

    expect(worker.currentPromptId).toBe('prompt-xyz-999');
  });

  test('notification hook captures prompt_id on worker', async () => {
    const worker = makeWorker();
    const factory = makeFactory();
    const hook = factory.createNotificationHook(worker);

    await hook({
      hook_event_name: 'Notification',
      message: 'Working on it',
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      prompt_id: 'prompt-notify-555',
    });

    expect(worker.currentPromptId).toBe('prompt-notify-555');
  });

  test('prompt_id updates when a new prompt arrives', async () => {
    const worker = makeWorker({ currentPromptId: 'old-prompt-id' });
    const factory = makeFactory();
    const hook = factory.createPermissionHook(worker);

    await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      prompt_id: 'new-prompt-id',
    });

    expect(worker.currentPromptId).toBe('new-prompt-id');
  });

  test('hooks tolerate missing prompt_id (backward compat)', async () => {
    const worker = makeWorker();
    const factory = makeFactory();
    const hook = factory.createPermissionHook(worker);

    await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      session_id: 'sess-1',
      transcript_path: '/tmp/t',
      cwd: '/tmp',
      // no prompt_id
    });

    expect(worker.currentPromptId).toBeUndefined();
  });
});
