/**
 * A runner killed mid-session must not strand its worker's server row.
 *
 * 2026-10-23, a Windows runner: an agent's `Get-Process bun,git | Stop-Process
 * -Force` killed the runner mid-session. Over the next restarts the worker's
 * record ended `error: "Killed: runner restarted, in-flight session
 * terminated"`, a later start skipped it as already terminal, the terminal
 * sweep deleted its worktree, and the server row read `running` nine hours on
 * while the runner heartbeated.
 *
 * The record was corrupted while the worker was alive: every reader of the
 * store (the terminal sweep, the history cache behind getWorkers) ran the
 * startup rewrite, so a live worker silent in one long tool call read `error`
 * on disk, and the crash after that left nothing marking it unsettled.
 *
 * Real filesystem, own BUILDD_HOME; the server is a stub.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LocalWorker } from '../../src/types';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'buildd-restart-report-'));
process.env.BUILDD_HOME = TEST_HOME;

let store: typeof import('../../src/worker-store');
let WorkerSyncCtor: typeof import('../../src/worker-sync').WorkerSync;

beforeAll(async () => {
  store = await import('../../src/worker-store');
  store.__resetWorkerStoreRoot();
  WorkerSyncCtor = (await import('../../src/worker-sync')).WorkerSync;
});
beforeEach(() => rmSync(join(TEST_HOME, 'workers'), { recursive: true, force: true }));
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const onDisk = (id: string) => JSON.parse(readFileSync(join(TEST_HOME, 'workers', `${id}.json`), 'utf-8'));

function liveWorker(): LocalWorker {
  return {
    id: 'w-killed-mid-session', taskId: 't-1', taskTitle: 'recon sweep', workspaceId: 'ws', workspaceName: 'ws',
    branch: 'buildd/t-1', status: 'working', startedAt: Date.now() - 3_600_000, lastActivity: Date.now() - 60_000,
    sessionId: 'sess-abcdef', worktreePath: join(TEST_HOME, 'gone-worktree'),
    messages: [], milestones: [], toolCalls: [], commits: [], output: [], hasNewActivity: false, currentAction: '',
    subagentTasks: [], checkpoints: [], checkpointEvents: new Set(), phaseText: null, phaseStart: null, phaseToolCount: 0, phaseTools: [],
  } as unknown as LocalWorker;
}

/** One runner start: a WorkerSync over a fresh map, with a stub server and manual timers. */
function boot(updateWorker: (id: string, body: any) => Promise<unknown>) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const ctx: any = {
    config: { localUiUrl: 'http://localhost:8766' },
    buildd: { updateWorker: mock(updateWorker) },
    workers: new Map(), sessions: new Map(), dirtyWorkers: new Set(), dirtyForDisk: new Set(),
    emit: () => {}, abort: async () => {}, sendMessage: async () => {},
    getAdaptiveStaleTimeout: () => 300_000, setAdaptiveStaleTimeout: () => {}, recentCycleTimes: [],
    probedWorkers: new Set(), addMilestone: () => {}, buildUserMessage: (c: string) => ({ content: c }),
    // The worktree was swept: the incident's "given up on locally".
    resumeProbe: { worktreeExists: () => false, claudeSessionExists: () => true, codexThreadExists: () => true },
    terminalReportTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms }); },
  };
  return { sync: new WorkerSyncCtor(ctx), ctx, timers };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('a runner killed mid-session', () => {
  test('reading the store while the worker runs does not rewrite its record', () => {
    store.saveWorker(liveWorker());
    // The sweep and getWorkers' history cache read the store every few seconds.
    store.loadAllWorkers();
    store.loadTerminalWorkersCached(Date.now() + 60_000);
    expect(onDisk('w-killed-mid-session').status).toBe('working');
  });

  test('a start that dies before settling the worker leaves it for the next start', () => {
    store.saveWorker(liveWorker());
    store.loadAllWorkers({ reconcileRestart: true }); // rewrite, then the process dies
    const persisted = onDisk('w-killed-mid-session');
    expect(persisted.status).toBe('error');
    expect(persisted.killedByRestart).toBe(true);

    const next = store.loadAllWorkers({ reconcileRestart: true });
    expect(next[0].killedByRestart).toBe(true);
  });

  test('the terminal sweep leaves an unsettled record alone', async () => {
    const { sweepTerminalWorktrees } = await import('../../src/terminal-worktree-sweep');
    const out = await sweepTerminalWorktrees({
      records: [{ id: 'w', status: 'error', killedByRestart: true, worktreePath: join(TEST_HOME, '.buildd-worktrees', 'x'), lastActivity: 0 }],
      inMemoryWorkers: [], now: Date.now(), retentionMs: 0, archiveDir: join(TEST_HOME, 'archive'),
    });
    expect(out).toEqual([]);
  });

  test('restored, given up on locally, and its failed PATCH is retried until the server has it', async () => {
    store.saveWorker(liveWorker());
    // First start: the server is unreachable for the report.
    let calls = 0;
    const first = boot(async () => { calls++; throw new TypeError('fetch failed'); });
    first.sync.restoreWorkersFromDisk();
    await flush();
    expect(calls).toBe(1);
    expect(first.timers).toHaveLength(1);
    // The report is on disk, so a crash now does not lose it.
    expect(onDisk('w-killed-mid-session').terminalReport?.payload.status).toBe('failed');
    expect(onDisk('w-killed-mid-session').killedByRestart).toBeUndefined();

    // Still down on the retry: backed off, still pending.
    first.timers.shift()!.fn();
    await flush();
    expect(calls).toBe(2);
    expect(first.timers[0].ms).toBeGreaterThan(5_000);

    // The process dies again before the server comes back. The next start
    // sends the report it finds on disk.
    const bodies: any[] = [];
    const second = boot(async (_id, body) => { bodies.push(body); return {}; });
    second.sync.restoreWorkersFromDisk();
    await flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ status: 'failed', crashReconciled: true });
    expect(bodies[0].error).toContain('its worktree is gone');
    expect(onDisk('w-killed-mid-session').terminalReport).toBeUndefined();

    // Acknowledged: a third start sends nothing.
    const third = boot(async () => { throw new Error('must not be called'); });
    third.sync.restoreWorkersFromDisk();
    await flush();
    expect(third.ctx.buildd.updateWorker).not.toHaveBeenCalled();
  });

  test('a 4xx is the server deciding: not resent', async () => {
    store.saveWorker(liveWorker());
    const { ServerRefusalError } = await import('../../src/server-refusal');
    const b = boot(async () => { throw ServerRefusalError.from({ status: 409, raw: '{"error":"already terminal"}', method: 'PATCH', endpoint: '/api/workers/w' }); });
    b.sync.restoreWorkersFromDisk();
    await flush();
    expect(b.timers).toHaveLength(0);
    expect(onDisk('w-killed-mid-session').terminalReport).toBeUndefined();
  });

  test('restored as paused is reported on the first sync tick', () => {
    store.saveWorker(liveWorker());
    const b = boot(async () => ({}));
    b.ctx.resumeProbe = { worktreeExists: () => true, claudeSessionExists: () => true, codexThreadExists: () => true };
    b.sync.restoreWorkersFromDisk();
    expect(b.ctx.workers.get('w-killed-mid-session')?.status).toBe('waiting');
    expect(b.ctx.dirtyWorkers.has('w-killed-mid-session')).toBe(true);
  });
});
