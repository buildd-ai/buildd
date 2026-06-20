/**
 * Phase 1C / R5: the resume branch must select the correct id per backend.
 *
 * RecoveryManager.resumeSession Layer 1 passes a resume id to startSession:
 *   - Claude worker → worker.sessionId
 *   - Codex worker  → worker.codexThreadId (NOT sessionId)
 * If the backend-appropriate id is missing it skips Layer 1 and falls through to
 * the reconstructed-context fallback (which still calls startSession, with no id).
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../../src/session-logger', () => ({
  sessionLog: mock(() => {}),
}));
mock.module('../../src/worker-store', () => ({
  saveWorker: () => {},
  loadWorker: () => null,
}));

import { RecoveryManager } from '../../src/recovery';
import type { LocalWorker } from '../../src/types';

interface StartSessionCall {
  resumeId: string | undefined;
  description: string;
}

let startSessionCalls: StartSessionCall[] = [];

function makeManager(opts?: { failFirst?: boolean }) {
  let calls = 0;
  const deps: any = {
    workers: new Map(),
    sessions: new Map(),
    buildd: {},
    resolver: { resolve: () => '/tmp/ws' },
    pendingPermissionRequests: new Map(),
    emit: () => {},
    addMilestone: () => {},
    unsubscribeFromWorker: () => {},
    startSession: mock(async (_w: LocalWorker, _cwd: string, task: any, resumeId?: string) => {
      startSessionCalls.push({ resumeId, description: task.description });
      calls += 1;
      // Simulate Layer 1 failure once so we can observe the Layer 2 fallback.
      if (opts?.failFirst && calls === 1 && resumeId) {
        throw new Error('resume failed');
      }
    }),
  };
  return new RecoveryManager(deps);
}

function makeWorker(overrides: Partial<LocalWorker>): LocalWorker {
  return {
    id: 'w1',
    taskId: 'task-1',
    taskTitle: 'T',
    workspaceId: 'ws1',
    workspaceName: 'ws',
    branch: 'b',
    status: 'done',
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

beforeEach(() => {
  startSessionCalls = [];
});

describe('resume branch chooses Codex vs Claude id (R5)', () => {
  test('Codex worker resumes with codexThreadId (not sessionId)', async () => {
    const mgr = makeManager();
    const worker = makeWorker({
      taskBackend: 'codex',
      codexThreadId: 'thread-codex-1',
      sessionId: 'claude-sess-should-be-ignored',
    });
    await mgr.resumeSession(worker, '/tmp/ws', 'follow up');

    expect(startSessionCalls.length).toBe(1);
    expect(startSessionCalls[0].resumeId).toBe('thread-codex-1');
  });

  test('Claude worker resumes with sessionId', async () => {
    const mgr = makeManager();
    const worker = makeWorker({
      taskBackend: 'claude',
      sessionId: 'claude-sess-1',
      codexThreadId: undefined,
    });
    await mgr.resumeSession(worker, '/tmp/ws', 'follow up');

    expect(startSessionCalls.length).toBe(1);
    expect(startSessionCalls[0].resumeId).toBe('claude-sess-1');
  });

  test('Codex worker without codexThreadId skips Layer 1 → Layer 2 with no resume id', async () => {
    const mgr = makeManager();
    const worker = makeWorker({
      taskBackend: 'codex',
      codexThreadId: undefined,
      // A leftover sessionId must NOT be used for a Codex worker.
      sessionId: 'stale-claude-sess',
    });
    await mgr.resumeSession(worker, '/tmp/ws', 'follow up');

    // Only the reconstructed-context fallback ran, with no resume id.
    expect(startSessionCalls.length).toBe(1);
    expect(startSessionCalls[0].resumeId).toBeUndefined();
  });

  test('Codex Layer 1 failure falls through to reconstructed context (Layer 2)', async () => {
    const mgr = makeManager({ failFirst: true });
    const worker = makeWorker({ taskBackend: 'codex', codexThreadId: 'thread-codex-2' });
    await mgr.resumeSession(worker, '/tmp/ws', 'follow up');

    // First call (Layer 1) threw; second call (Layer 2) reconstructs with no id.
    expect(startSessionCalls.length).toBe(2);
    expect(startSessionCalls[0].resumeId).toBe('thread-codex-2');
    expect(startSessionCalls[1].resumeId).toBeUndefined();
  });
});
