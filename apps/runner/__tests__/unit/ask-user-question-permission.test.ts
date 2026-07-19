/**
 * Regression tests for the AskUserQuestion redundant double-prompt bug.
 *
 * Bug: on a NON-autonomous worker, AskUserQuestion was NOT auto-denied by the
 * PreToolUse hook, so it fell through to the generic permission gates
 * (PermissionRequest hook / canUseTool). The user was prompted to "grant
 * permission for the agent to ask a question" — a nonsensical
 * "may I ask you something? → yes → here's the question" double-step.
 *
 * AskUserQuestion is the agent's direct channel to the user; the question
 * content itself is surfaced to the worker UI by handleMessage
 * (waitingFor.type = 'question'). It must never be gated behind a separate
 * tool-permission approval.
 *
 * Desired behavior:
 * - NON-autonomous + AskUserQuestion → allowed by every gate, no generic
 *   tool-permission request (no waitingFor.type = 'permission'). The question
 *   still reaches the user via handleMessage (unaffected here).
 * - AUTONOMOUS (inputAsRetry=false) + AskUserQuestion → still denied.
 * - Other tools (Bash/Write) → permission gates unchanged.
 *
 * Run: bun test apps/runner/__tests__/unit/ask-user-question-permission.test.ts
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
  } as LocalWorker;
}

const mockUpdateWorker = mock(async () => ({}));
const mockBuildd = { updateWorker: mockUpdateWorker } as any;
const mockAddMilestone = mock((_w: LocalWorker, _m: Milestone) => {});
const mockEmit = mock((_e: any) => {});

function makeFactory(
  config: { inputAsRetry?: boolean } = {},
  pendingPermissionRequests = new Map<string, any>(),
) {
  return new HookFactory({
    config,
    buildd: mockBuildd,
    addMilestone: mockAddMilestone,
    emit: mockEmit,
    pendingPermissionRequests,
  });
}

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which database should I use?',
      header: 'Database choice',
      options: [
        { label: 'Postgres', description: 'Relational' },
        { label: 'SQLite', description: 'Embedded' },
      ],
    },
  ],
};

describe('AskUserQuestion permission gates', () => {
  describe('PreToolUse hook (createPermissionHook)', () => {
    test('non-autonomous (inputPolicy=allow): AskUserQuestion is ALLOWED, not denied', async () => {
      const worker = makeWorker();
      const hook = makeFactory().createPermissionHook(worker, { inputPolicy: 'allow' });

      const result: any = await hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: QUESTION_INPUT,
      } as any);

      expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
    });

    test('important-only (non-autonomous): AskUserQuestion is ALLOWED', async () => {
      const worker = makeWorker();
      const hook = makeFactory().createPermissionHook(worker, { inputPolicy: 'important-only' });

      const result: any = await hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: QUESTION_INPUT,
      } as any);

      expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
    });

    test('autonomous + inputAsRetry=false: AskUserQuestion is still DENIED', async () => {
      const worker = makeWorker();
      // config.inputAsRetry === false is required for the autonomous hard-block
      const hook = makeFactory({ inputAsRetry: false }).createPermissionHook(worker, {
        inputPolicy: 'autonomous',
      });

      const result: any = await hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: QUESTION_INPUT,
      } as any);

      expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
  });

  describe('PermissionRequest hook (createPermissionRequestHook)', () => {
    test('AskUserQuestion: allowed straight through with NO redundant permission prompt', async () => {
      const pending = new Map<string, any>();
      const worker = makeWorker();
      const hook = makeFactory({}, pending).createPermissionRequestHook(worker);

      const result: any = await hook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: QUESTION_INPUT,
      } as any);

      // Allowed via hookSpecificOutput.decision
      expect(result.hookSpecificOutput?.decision?.behavior).toBe('allow');

      // Crucially: it must NOT surface a generic "grant permission" prompt.
      expect(worker.waitingFor).toBeUndefined();
      expect(worker.status).toBe('working');
      expect(pending.has(worker.id)).toBe(false);
    });

    test('control: a non-AskUserQuestion tool (Bash) STILL surfaces a permission prompt', async () => {
      const pending = new Map<string, any>();
      const worker = makeWorker();
      const hook = makeFactory({}, pending).createPermissionRequestHook(worker);

      // Don't await — it blocks until the user resolves.
      hook({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      } as any);

      expect(worker.waitingFor?.type).toBe('permission');
      expect(worker.waitingFor?.toolName).toBe('Bash');
      expect(pending.has(worker.id)).toBe(true);
    });
  });

  describe('canUseTool (createCanUseToolCallback)', () => {
    const BASE_OPTIONS = {
      signal: new AbortController().signal,
      toolUseID: 'tool-use-1',
      requestId: 'req-1',
    };

    test('main agent AskUserQuestion: allowed, no waiting state', async () => {
      const pending = new Map<string, any>();
      const worker = makeWorker();
      const cb = makeFactory({}, pending).createCanUseToolCallback(worker, false);

      const result = await cb('AskUserQuestion', QUESTION_INPUT, BASE_OPTIONS);

      expect(result?.behavior).toBe('allow');
      expect(worker.status).toBe('working');
      expect(worker.waitingFor).toBeUndefined();
      expect(pending.has(worker.id)).toBe(false);
    });

    test('subagent AskUserQuestion: allowed WITHOUT a redundant permission prompt', async () => {
      const pending = new Map<string, any>();
      const worker = makeWorker();
      const cb = makeFactory({}, pending).createCanUseToolCallback(worker, false);

      const result = await cb('AskUserQuestion', QUESTION_INPUT, {
        ...BASE_OPTIONS,
        agentID: 'subagent-abc',
        title: 'Subagent wants to ask a question',
      });

      // Allowed immediately, never routed to the user as a permission approval.
      expect(result?.behavior).toBe('allow');
      expect(worker.status).toBe('working');
      expect(worker.waitingFor).toBeUndefined();
      expect(pending.has(worker.id)).toBe(false);
    });

    test('control: a subagent Bash call STILL blocks on a permission prompt', async () => {
      const pending = new Map<string, any>();
      const worker = makeWorker();
      const cb = makeFactory({}, pending).createCanUseToolCallback(worker, false);

      // Don't await — it blocks until resolved.
      cb('Bash', { command: 'npm test' }, {
        ...BASE_OPTIONS,
        agentID: 'subagent-abc',
      });

      expect(worker.status).toBe('waiting');
      expect(worker.waitingFor?.type).toBe('permission');
      expect(pending.has(worker.id)).toBe(true);
    });
  });
});
