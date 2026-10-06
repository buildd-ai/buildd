/**
 * lib/task-actions: the action set every task surface draws, and the only
 * client requests to /start and /reassign.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  claimTaskCommand,
  requestTaskRetry,
  requestTaskStart,
  taskActionPhase,
  taskActionSet,
  type TaskActionState,
} from './task-actions';

const base: TaskActionState = { phase: 'pending', isBlocked: false, backend: 'claude', hasQuestion: false, hasHistory: true };

describe('taskActionSet', () => {
  it('a queued runner task offers Run now only', () => {
    expect(taskActionSet(base)).toEqual(['run_now']);
  });

  it('a queued task in a local mission leads with its claim_task command', () => {
    expect(taskActionSet({ ...base, missionExecutor: 'local' })).toEqual(['claim_hint', 'run_now']);
  });

  it('a failed task offers retry, the other backend and its history', () => {
    expect(taskActionSet({ ...base, phase: 'failed' })).toEqual(['retry', 'switch_backend', 'history']);
    expect(taskActionSet({ ...base, phase: 'failed', backend: null, hasHistory: false })).toEqual(['retry']);
  });

  it('the other backend is offered only when it is not known to be unconfigured', () => {
    expect(taskActionSet({ ...base, phase: 'failed', otherBackendAvailable: false })).toEqual(['retry', 'history']);
    expect(taskActionSet({ ...base, phase: 'failed', otherBackendAvailable: true })).toEqual(['retry', 'switch_backend', 'history']);
  });

  it('a dependency-blocked task only says so', () => {
    expect(taskActionSet({ ...base, phase: 'blocked', isBlocked: true })).toEqual(['blocked']);
  });

  it('a waiting task with a question offers the answer; without one, nothing', () => {
    expect(taskActionSet({ ...base, phase: 'waiting_input', hasQuestion: true })).toEqual(['answer']);
    expect(taskActionSet({ ...base, phase: 'waiting_input' })).toEqual([]);
  });

  it('landed and running tasks offer nothing', () => {
    expect(taskActionSet({ ...base, phase: 'completed' })).toEqual([]);
    expect(taskActionSet({ ...base, phase: 'running' })).toEqual([]);
  });

  it('the pending family the page used to start (budget paused, subject dead) still offers Run now', () => {
    expect(taskActionSet({ ...base, phase: 'budget_paused' })).toEqual(['run_now']);
    expect(taskActionSet({ ...base, phase: 'subject_dead' })).toEqual(['run_now']);
  });
});

describe('taskActionPhase', () => {
  it('pending with an unmet dependency is blocked', () => {
    expect(taskActionPhase({ taskStatus: 'pending', blockedByCount: 2 })).toEqual({ phase: 'blocked', isBlocked: true });
  });
  it('a question outranks a failed status', () => {
    expect(taskActionPhase({ taskStatus: 'failed', workerWaitingFor: { prompt: 'x' }, blockedByCount: 0 }).phase).toBe('waiting_input');
  });
});

describe('claimTaskCommand', () => {
  it('is the MCP call a session makes', () => {
    expect(claimTaskCommand('t1')).toBe('claim_task {taskId: "t1"}');
  });
});

describe('requests', () => {
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; method?: string; body: unknown }> = [];
  function stub(status: number, body: Record<string, unknown> = {}) {
    calls = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { ok: status < 400, status, json: async () => body } as Response;
    }) as unknown as typeof fetch;
  }
  afterEach(() => { globalThis.fetch = realFetch; });

  it('requestTaskStart posts only the flags it was given', async () => {
    stub(200);
    expect(await requestTaskStart('t1')).toEqual({ ok: true });
    await requestTaskStart('t1', { forceOverride: true });
    await requestTaskStart('t1', { capExempt: true, targetLocalUiUrl: 'http://ui' });
    expect(calls.map(c => [c.url, c.method, c.body])).toEqual([
      ['/api/tasks/t1/start', 'POST', {}],
      ['/api/tasks/t1/start', 'POST', { forceOverride: true }],
      ['/api/tasks/t1/start', 'POST', { targetLocalUiUrl: 'http://ui', capExempt: true }],
    ]);
  });

  it('a 422 with a gate reason is a refusal; any other error is not', async () => {
    stub(422, { gateReason: 'mission_local', canForce: true, error: 'local' });
    const gated = await requestTaskStart('t1');
    expect(gated.ok).toBe(false);
    expect(!gated.ok && gated.refusal?.gateReason).toBe('mission_local');
    stub(500, { error: 'boom' });
    const failed = await requestTaskStart('t1');
    expect(!failed.ok && failed.refusal).toBeNull();
    expect(!failed.ok && failed.error).toBe('boom');
  });

  it('requestTaskRetry forces the reassign and sends a backend only when switching', async () => {
    stub(200);
    await requestTaskRetry('t1');
    await requestTaskRetry('t1', { backend: 'codex' });
    expect(calls.map(c => [c.url, c.body])).toEqual([
      ['/api/tasks/t1/reassign?force=true', {}],
      ['/api/tasks/t1/reassign?force=true', { backend: 'codex' }],
    ]);
    stub(409, { error: 'nope' });
    expect(await requestTaskRetry('t1')).toEqual({ ok: false, error: 'nope' });
  });
});
