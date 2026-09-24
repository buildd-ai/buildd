/**
 * Unit tests for the PreToolUse loop-verification hook
 * (HookFactory.createLoopVerificationHook).
 *
 * On a command-loop task the agent's own complete_task goes straight to the
 * server, which decides the loop on that PATCH. The hook runs the command
 * first and records the evidence on the worker row. The end-to-end path is
 * covered in task-shape-contract.test.ts; this file pins the hook's own rules:
 * which calls it acts on, and that it never blocks complete_task.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/loop-verification-hook.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

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

const EVIDENCE = { workerId: 'w1', iteration: 2, conditionType: 'command', command: 'bun run check', exitCode: 0, outcome: 'ok' };

const mockUpdateWorker = mock(async () => ({}));
const mockCollect = mock(async (): Promise<Record<string, unknown> | undefined> => EVIDENCE);

function makeFactory() {
  return new HookFactory({
    config: {},
    buildd: { updateWorker: mockUpdateWorker } as any,
    addMilestone: () => {},
    emit: () => {},
    pendingPermissionRequests: new Map(),
  });
}

const worker = { id: 'w1', milestones: [] } as unknown as LocalWorker;

function preToolUse(toolName: string, toolInput: Record<string, unknown>) {
  return { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput } as any;
}

async function run(input: any) {
  const hook = makeFactory().createLoopVerificationHook(worker, mockCollect);
  return hook(input, 'toolu_1', { signal: new AbortController().signal });
}

describe('createLoopVerificationHook', () => {
  beforeEach(() => {
    mockUpdateWorker.mockReset();
    mockUpdateWorker.mockImplementation(async () => ({}));
    mockCollect.mockReset();
    mockCollect.mockImplementation(async () => EVIDENCE);
  });

  test('complete_task: runs the command and records the evidence before the call proceeds', async () => {
    const out = await run(preToolUse('mcp__buildd__buildd', { action: 'complete_task', params: { summary: 'Done.' } }));
    expect(mockCollect).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorker).toHaveBeenCalledWith('w1', { verificationEvidence: EVIDENCE });
    // Never a permission decision: it must not block or auto-approve anything.
    expect(out).toEqual({});
  });

  test('other buildd actions are ignored', async () => {
    await run(preToolUse('mcp__buildd__buildd', { action: 'create_pr', params: {} }));
    await run(preToolUse('mcp__buildd__buildd', { action: 'update_progress', params: {} }));
    expect(mockCollect).not.toHaveBeenCalled();
    expect(mockUpdateWorker).not.toHaveBeenCalled();
  });

  test('other tools are ignored', async () => {
    await run(preToolUse('Bash', { command: 'echo complete_task' }));
    expect(mockCollect).not.toHaveBeenCalled();
  });

  test('a complete_task reporting an error is a failure, not a completion to verify', async () => {
    await run(preToolUse('mcp__buildd__buildd', { action: 'complete_task', params: { error: 'Could not build.' } }));
    expect(mockCollect).not.toHaveBeenCalled();
    expect(mockUpdateWorker).not.toHaveBeenCalled();
  });

  test('no resolvable command: nothing is recorded', async () => {
    mockCollect.mockImplementation(async () => undefined);
    const out = await run(preToolUse('mcp__buildd__buildd', { action: 'complete_task', params: {} }));
    expect(mockUpdateWorker).not.toHaveBeenCalled();
    expect(out).toEqual({});
  });

  test('fail-open: a failed evidence write never blocks complete_task', async () => {
    mockUpdateWorker.mockImplementation(async () => { throw new Error('network down'); });
    const out = await run(preToolUse('mcp__buildd__buildd', { action: 'complete_task', params: {} }));
    expect(out).toEqual({});
  });
});
