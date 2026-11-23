/**
 * A tier or model change made while a session exists continues that same
 * session on the new model: the server answers the runner's resume call with
 * the model, and the resume runs on it by the session's own id.
 */
import { describe, test, expect } from 'bun:test';
import { adoptServerSessionModel, takesSessionModel } from '../../src/session-model-switch';
import { RecoveryManager, type RecoveryDeps } from '../../src/recovery';
import type { LocalWorker } from '../../src/types';

const worker = (over: Partial<LocalWorker> = {}): LocalWorker => ({
  id: 'w-switch', taskId: 't-switch', taskTitle: 'Switch', taskDescription: 'desc', taskMode: 'execution',
  workspaceId: 'ws-1', workspaceName: 'ws', status: 'waiting', sessionId: 'sess-1', sessionModel: 'model-a',
  milestones: [], toolCalls: [], messages: [], output: [], commits: [], ...over,
} as unknown as LocalWorker);

describe('adoptServerSessionModel', () => {
  test('adopts the model the server answered the resume call with', () => {
    const w = worker();
    expect(adoptServerSessionModel(w, { sessionModel: ' model-b ' }, {})).toEqual({ from: 'model-a', to: 'model-b' });
    expect(w.sessionModel).toBe('model-b');
    expect(w.claimedModel).toBe('model-b');
  });

  test('leaves the session alone when the server names no model, or the one it is on', () => {
    const w = worker();
    expect(adoptServerSessionModel(w, {}, {})).toBeNull();
    expect(adoptServerSessionModel(w, null, {})).toBeNull();
    expect(adoptServerSessionModel(w, { sessionModel: 'model-a' }, {})).toBeNull();
    expect(adoptServerSessionModel(w, { sessionModel: 42 }, {})).toBeNull();
    expect(w.sessionModel).toBe('model-a');
  });

  test('a runner told to ignore per-task models neither claims to take one nor adopts one', () => {
    const env = { BUILDD_HONOR_TASK_MODEL: '0' };
    const w = worker();
    expect(takesSessionModel(env)).toBe(false);
    expect(takesSessionModel({})).toBe(true);
    expect(adoptServerSessionModel(w, { sessionModel: 'model-b' }, env)).toBeNull();
    expect(w.sessionModel).toBe('model-a');
  });
});

describe('resume after a model change', () => {
  function recovery() {
    const calls: Array<{ task: any; resumeId?: string }> = [];
    const deps = {
      workers: new Map(), sessions: new Map(),
      buildd: { updateWorker: async () => ({}) },
      resolver: { resolve: () => '/tmp/x' },
      pendingPermissionRequests: new Map(),
      emit: () => {}, addMilestone: () => {}, unsubscribeFromWorker: () => {},
      startSession: async (_w: LocalWorker, _cwd: string, task: any, resumeId?: string) => { calls.push({ task, resumeId }); },
    } as unknown as RecoveryDeps;
    return { manager: new RecoveryManager(deps), calls };
  }

  test('Claude: the same session id is resumed on the new model', async () => {
    const w = worker();
    adoptServerSessionModel(w, { sessionModel: 'model-b' }, {});
    const { manager, calls } = recovery();
    await manager.resumeSession(w, '/tmp/x', 'carry on');
    expect(calls[0].resumeId).toBe('sess-1');
    expect(calls[0].task.context.model).toBe('model-b');
  });

  test('Codex: the same thread id is resumed on the new model', async () => {
    const w = worker({ taskBackend: 'codex', codexThreadId: 'thread-1', sessionModel: 'codex-a' } as Partial<LocalWorker>);
    adoptServerSessionModel(w, { sessionModel: 'codex-b' }, {});
    const { manager, calls } = recovery();
    await manager.resumeSession(w, '/tmp/x', 'carry on');
    expect(calls[0].resumeId).toBe('thread-1');
    expect(calls[0].task.context.model).toBe('codex-b');
    expect(calls[0].task.backend).toBe('codex');
  });
});
