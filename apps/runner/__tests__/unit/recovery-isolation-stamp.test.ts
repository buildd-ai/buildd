/**
 * Regression (task 4ad0f95a): a trusted_local task the claim stamped to run
 * reduced on an opted-out runner (BUILDD_DISABLE_SANDBOX=1 +
 * BUILDD_ALLOW_REDUCED_ISOLATION=1) ran, then failed on its follow-up with
 * "Not started: The task needs protected isolation ...".
 *
 * RecoveryManager rebuilds a stub task for every restart path (SDK resume,
 * reconstructed-context fallback, retry, doctor). The stub carried only
 * `context.model`, so the claim's isolation stamp was gone and startSession's
 * re-decision read the task as unstamped, i.e. protected. The stub must carry
 * the stamp the session started under — and nothing laxer.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RecoveryManager, type RecoveryDeps } from '../../src/recovery';
import { saveWorker, loadWorker, loadAllWorkers, __resetWorkerStoreRoot } from '../../src/worker-store';
import { decideTaskIsolation, taskIsolationRequirement, type RunnerIsolationRecord, type TaskIsolationStamp } from '@buildd/shared';
import type { LocalWorker } from '../../src/types';

// retry() saves the worker; keep every write in a scratch BUILDD_HOME.
const home = mkdtempSync(join(tmpdir(), 'buildd-iso-carry-'));
const prevHome = process.env.BUILDD_HOME;
process.env.BUILDD_HOME = home;
__resetWorkerStoreRoot();
afterAll(() => {
  if (prevHome === undefined) delete process.env.BUILDD_HOME; else process.env.BUILDD_HOME = prevHome;
  __resetWorkerStoreRoot();
  rmSync(home, { recursive: true, force: true });
});

const TRUSTED: TaskIsolationStamp = { requirement: 'trusted_local', source: 'single_owner_team', mode: 'reduced' };

/** The coder-workspace runner's record: sandbox off by the operator, opted in to reduced. */
function optedOutRecord(): RunnerIsolationRecord {
  const now = new Date().toISOString();
  const none = { mechanism: 'none' as const, scope: [], reason: 'opt_out' as const };
  return {
    platform: 'linux',
    evidence: ['test'],
    claude: none,
    codex: { 'read-only': none, 'workspace-write': none },
    probeAt: now,
    processStartedAt: now,
    runnerVersion: 'test',
    reducedOptIn: true,
  };
}

function makeWorker(overrides: Partial<LocalWorker> = {}): LocalWorker {
  return {
    id: 'w-iso-carry',
    taskId: 't-iso-carry',
    taskTitle: 'Isolation carry',
    taskDescription: 'desc',
    taskMode: 'execution',
    workspaceId: 'ws-1',
    workspaceName: 'ws',
    branch: 'buildd/iso-carry',
    status: 'done',
    sessionId: 'sess-1',
    sessionModel: 'claude-session-model',
    taskIsolation: TRUSTED,
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
  const workers = new Map<string, LocalWorker>();
  const deps = {
    workers,
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
  return { deps, calls, workers };
}

/** What startSession decides for the stub on the opted-out runner. */
function decideOnOptedOutRunner(task: any) {
  return decideTaskIsolation({
    requirement: taskIsolationRequirement(task.context),
    record: optedOutRecord(),
    backend: 'claude',
    codexMode: 'workspace-write',
  });
}

describe('RecoveryManager carries the claim isolation stamp into restarted sessions', () => {
  test('SDK resume (layer 1) of a trusted_local task still runs reduced on the opted-out runner', async () => {
    const { deps, calls } = makeDeps();
    await new RecoveryManager(deps).resumeSession(makeWorker(), '/tmp/x', 'the owner answered');

    expect(calls.length).toBe(1);
    expect(taskIsolationRequirement(calls[0].task.context)).toBe('trusted_local');
    const decision = decideOnOptedOutRunner(calls[0].task);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.mode).toBe('reduced');
  });

  test('reconstructed-context fallback (layer 2) keeps the stamp too', async () => {
    const { deps, calls } = makeDeps({ failFirst: true });
    await new RecoveryManager(deps).resumeSession(makeWorker(), '/tmp/x', 'the owner answered');

    expect(calls.length).toBe(2);
    expect(taskIsolationRequirement(calls[1].task.context)).toBe('trusted_local');
  });

  test('retry keeps the stamp', async () => {
    const { deps, calls, workers } = makeDeps();
    const worker = makeWorker({ status: 'error' as LocalWorker['status'] });
    workers.set(worker.id, worker);
    await new RecoveryManager(deps).retry(worker.id);
    for (let i = 0; i < 20 && calls.length === 0; i++) await new Promise(r => setTimeout(r, 10));

    expect(calls.length).toBe(1);
    expect(taskIsolationRequirement(calls[0].task.context)).toBe('trusted_local');
  });

  test('the model still rides along with the stamp', async () => {
    const { deps, calls } = makeDeps();
    await new RecoveryManager(deps).resumeSession(makeWorker(), '/tmp/x', 'follow up');

    expect(calls[0].task.context.model).toBe('claude-session-model');
  });

  test('a worker with no recorded stamp stays protected: a protected task never runs reduced', async () => {
    const { deps, calls } = makeDeps();
    await new RecoveryManager(deps).resumeSession(makeWorker({ taskIsolation: undefined }), '/tmp/x', 'follow up');

    expect(taskIsolationRequirement(calls[0].task.context)).toBe('protected');
    expect(decideOnOptedOutRunner(calls[0].task).ok).toBe(false);
  });

  test('a protected stamp is carried as protected', async () => {
    const { deps, calls } = makeDeps();
    const stamp: TaskIsolationStamp = { requirement: 'protected', source: 'default', mode: 'enforced' };
    await new RecoveryManager(deps).resumeSession(makeWorker({ taskIsolation: stamp }), '/tmp/x', 'follow up');

    expect(taskIsolationRequirement(calls[0].task.context)).toBe('protected');
  });
});

describe('the worker store keeps the stamp across a runner restart', () => {
  test('loadWorker and loadAllWorkers restore taskIsolation', () => {
    const worker = makeWorker({ id: 'w-iso-store', lastActivity: Date.now(), startedAt: Date.now() } as Partial<LocalWorker>);
    saveWorker(worker);

    expect(loadWorker(worker.id)?.taskIsolation).toEqual(TRUSTED);
    expect(loadAllWorkers().find(w => w.id === worker.id)?.taskIsolation).toEqual(TRUSTED);
  });

  test('a malformed stored stamp is dropped, not trusted', () => {
    const worker = makeWorker({ id: 'w-iso-store-bad', lastActivity: Date.now(), startedAt: Date.now(), taskIsolation: { requirement: 'anything' } } as unknown as Partial<LocalWorker>);
    saveWorker(worker);

    expect(loadWorker(worker.id)?.taskIsolation).toBeUndefined();
  });
});
