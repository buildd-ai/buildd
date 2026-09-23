/**
 * Regression: a follow-up/resume on a finished worker must run on the model
 * that session ran on, not the runner-global default.
 *
 * RecoveryManager rebuilds a stub task for every restart path (SDK resume,
 * reconstructed-context fallback, retry, doctor). The stub used to carry no
 * `context`, so resolveSessionModel() had no per-task model to honour and fell
 * back to config.model — a task routed to one model silently resumed on
 * another.
 */
import { describe, test, expect } from 'bun:test';
import { RecoveryManager, type RecoveryDeps } from '../../src/recovery';
import { resolveSessionModel } from '../../src/prompt-builder';
import type { LocalWorker } from '../../src/types';

const RUNNER_DEFAULT = 'runner-default-model';
const SESSION_MODEL = 'claude-session-model';

function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  return {
    id: 'w-model-carry',
    taskId: 't-model-carry',
    taskTitle: 'Model carry',
    taskDescription: 'desc',
    taskMode: 'execution',
    workspaceId: 'ws-1',
    workspaceName: 'ws',
    status: 'done',
    sessionId: 'sess-1',
    sessionModel: SESSION_MODEL,
    milestones: [],
    toolCalls: [],
    messages: [],
    output: [],
    commits: [],
    ...overrides,
  } as unknown as LocalWorker;
}

function makeDeps(opts: { failFirst?: boolean } = {}) {
  const calls: Array<{ task: any; resumeId?: string }> = [];
  let n = 0;
  const deps = {
    workers: new Map(),
    sessions: new Map(),
    buildd: { updateWorker: async () => ({}) },
    resolver: { resolve: () => '/tmp/x' },
    pendingPermissionRequests: new Map(),
    emit: () => {},
    addMilestone: () => {},
    unsubscribeFromWorker: () => {},
    startSession: async (_w: LocalWorker, _cwd: string, task: any, resumeId?: string) => {
      calls.push({ task, resumeId });
      n++;
      if (opts.failFirst && n === 1) throw new Error('resume failed');
    },
  } as unknown as RecoveryDeps;
  return { deps, calls };
}

describe('RecoveryManager carries the session model into restarted sessions', () => {
  test('SDK resume (layer 1) runs on the worker session model, not the runner default', async () => {
    const { deps, calls } = makeDeps();
    const mgr = new RecoveryManager(deps);
    await mgr.resumeSession(makeWorker(), '/tmp/x', 'follow up');

    expect(calls.length).toBe(1);
    expect(calls[0].resumeId).toBe('sess-1');
    expect(resolveSessionModel(calls[0].task.context, RUNNER_DEFAULT, true)).toBe(SESSION_MODEL);
  });

  test('reconstructed-context fallback (layer 2) also keeps the session model', async () => {
    const { deps, calls } = makeDeps({ failFirst: true });
    const mgr = new RecoveryManager(deps);
    await mgr.resumeSession(makeWorker(), '/tmp/x', 'follow up');

    expect(calls.length).toBe(2);
    expect(resolveSessionModel(calls[1].task.context, RUNNER_DEFAULT, true)).toBe(SESSION_MODEL);
  });

  test('a worker with no recorded session model still falls back to the runner default', async () => {
    const { deps, calls } = makeDeps();
    const mgr = new RecoveryManager(deps);
    await mgr.resumeSession(makeWorker({ sessionModel: undefined }), '/tmp/x', 'follow up');

    expect(resolveSessionModel(calls[0].task.context, RUNNER_DEFAULT, true)).toBe(RUNNER_DEFAULT);
  });
});
