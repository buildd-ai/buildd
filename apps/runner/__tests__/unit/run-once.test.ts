/**
 * `buildd --once --task <id>` (run-once.ts): claim one task, run it to a
 * terminal state, flush, exit with a code the supervisor can act on.
 *
 * Everything is dependency-injected — no real sessions, no module mocks.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  runOnce,
  parseOnceArgs,
  buildOnceConfig,
  classifyClaimFailure,
  createOnceResolver,
  resolveOnceMaxWaitMs,
  flushOutboxWithRetry,
  EXIT_COMPLETED,
  EXIT_FAILED,
  EXIT_CLAIM_REFUSED,
  EXIT_USAGE,
  DEFAULT_ONCE_MAX_WAIT_MS,
  WORKER_ID_LINE_PREFIX,
  type RunOnceDeps,
  type OnceWorkerManager,
} from '../../src/run-once';

const TASK_ID = 'task-1234abcd';
const TASK = { id: TASK_ID, title: 'Example task', workspaceId: 'ws-1', workspace: { name: 'example', repo: 'https://github.com/example/repo' } };

type Status = 'idle' | 'working' | 'done' | 'error' | 'stale' | 'waiting';

/** A fake manager whose worker walks through `statuses`, one per poll. */
function fakeManager(opts: {
  claim?: () => Promise<{ id: string } | null>;
  statuses?: Status[];
  liveSessionPolls?: number;
} = {}) {
  const calls: string[] = [];
  const claimed: any[] = [];
  const aborted: Array<{ id: string; reason?: string }> = [];
  const statuses = [...(opts.statuses ?? ['working', 'done'])];
  let live = opts.liveSessionPolls ?? 0;
  const wm: OnceWorkerManager = {
    async claimAndStart(task) {
      calls.push('claimAndStart');
      claimed.push(task);
      return opts.claim ? opts.claim() : { id: 'worker-1' };
    },
    getWorker() {
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return { status: s };
    },
    hasLiveSession() {
      if (live > 0) { live--; return true; }
      return false;
    },
    async abort(id, reason) { calls.push('abort'); aborted.push({ id, reason }); },
    async flushToServer() { calls.push('flushToServer'); },
    destroy() { calls.push('destroy'); },
  };
  return { wm, calls, claimed, aborted };
}

function deps(wm: OnceWorkerManager, overrides: Partial<RunOnceDeps> = {}) {
  let t = 0;
  const flushed: number[] = [];
  const d: RunOnceDeps = {
    getTask: async (id) => (id === TASK_ID ? TASK : null),
    workerManager: wm,
    flushOutbox: async () => { flushed.push(1); return { remaining: 0 }; },
    maxWaitMs: 60_000,
    pollMs: 1_000,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    log: () => {},
    ...overrides,
  };
  return { d, flushed };
}

describe('exit codes', () => {
  test('are distinct and never collide with the launcher restart code (75)', () => {
    const codes = [EXIT_COMPLETED, EXIT_FAILED, EXIT_CLAIM_REFUSED, EXIT_USAGE];
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(75);
    expect(EXIT_COMPLETED).toBe(0);
  });
});

describe('parseOnceArgs', () => {
  test('not in once mode without --once', () => {
    expect(parseOnceArgs(['bun', 'index.ts', '--task', 'x'])).toEqual({ once: false });
  });

  test('--once --task <id>', () => {
    expect(parseOnceArgs(['bun', 'index.ts', '--once', '--task', TASK_ID])).toEqual({ once: true, taskId: TASK_ID });
  });

  test('--task=<id> form', () => {
    expect(parseOnceArgs(['bun', 'index.ts', '--task=' + TASK_ID, '--once'])).toEqual({ once: true, taskId: TASK_ID });
  });

  test('missing --task is a usage error', () => {
    const r = parseOnceArgs(['bun', 'index.ts', '--once']);
    expect(r.once).toBe(true);
    expect('error' in r && r.error).toBeTruthy();
  });

  test('--task followed by another flag is a usage error', () => {
    const r = parseOnceArgs(['bun', 'index.ts', '--once', '--task', '--debug']);
    expect('error' in r && r.error).toBeTruthy();
  });
});

describe('runOnce', () => {
  test('happy path: claims the given task, flushes the outbox, exits 0', async () => {
    const { wm, calls, claimed } = fakeManager({ statuses: ['working', 'working', 'done'] });
    const { d, flushed } = deps(wm);
    const code = await runOnce({ taskId: TASK_ID }, d);
    expect(code).toBe(EXIT_COMPLETED);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(TASK_ID);
    expect(calls).toContain('flushToServer');
    expect(flushed.length).toBeGreaterThan(0);
    // Sync to the server happens before teardown.
    expect(calls.indexOf('flushToServer')).toBeLessThan(calls.indexOf('destroy'));
  });

  test('prints a machine-readable BUILDD_WORKER_ID line once the worker exists', async () => {
    // The Cloudflare WorkerAgent only knows the task ID; it reads this line to
    // mark the worker failed if the container dies before the runner reports.
    const { wm } = fakeManager({ claim: async () => ({ id: 'worker-abc' }) });
    const lines: string[] = [];
    const { d } = deps(wm, { log: (m) => lines.push(m) });
    await runOnce({ taskId: TASK_ID }, d);
    expect(lines.filter(l => l.startsWith(`${WORKER_ID_LINE_PREFIX}`))).toEqual([`${WORKER_ID_LINE_PREFIX}worker-abc`]);
    expect(WORKER_ID_LINE_PREFIX).toBe('BUILDD_WORKER_ID=');
  });

  test('prints no BUILDD_WORKER_ID line when nothing was claimed', async () => {
    const { wm } = fakeManager({ claim: async () => null });
    const lines: string[] = [];
    const { d } = deps(wm, { log: (m) => lines.push(m) });
    await runOnce({ taskId: TASK_ID }, d);
    expect(lines.some(l => l.startsWith('BUILDD_WORKER_ID='))).toBe(false);
  });

  test('does not report done while the session is still tearing down', async () => {
    const { wm } = fakeManager({ statuses: ['done'], liveSessionPolls: 3 });
    let slept = 0;
    const { d } = deps(wm, { sleep: async () => { slept++; } });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_COMPLETED);
    expect(slept).toBeGreaterThanOrEqual(3);
  });

  test('claim refused by the server (nothing claimed) → refused code, no session', async () => {
    const { wm, calls } = fakeManager({
      claim: async () => { throw Object.assign(new Error('rejected'), { claimError: 'server_rejected', claimReason: 'no_pending_tasks' }); },
    });
    const { d } = deps(wm);
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_CLAIM_REFUSED);
    expect(calls).not.toContain('abort');
    expect(calls).toContain('destroy');
  });

  test('claimAndStart returning null (not started) → refused code', async () => {
    const { wm } = fakeManager({ claim: async () => null });
    const { d } = deps(wm);
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_CLAIM_REFUSED);
  });

  test('HTTP 409 on claim → refused; HTTP 503 on claim → failed (retryable)', async () => {
    const refusal = (status: number) => Object.assign(new Error(`API error: ${status} - {}`), { name: 'ServerRefusalError', status });
    const a = fakeManager({ claim: async () => { throw refusal(409); } });
    expect(await runOnce({ taskId: TASK_ID }, deps(a.wm).d)).toBe(EXIT_CLAIM_REFUSED);
    const b = fakeManager({ claim: async () => { throw refusal(503); } });
    expect(await runOnce({ taskId: TASK_ID }, deps(b.wm).d)).toBe(EXIT_FAILED);
  });

  test('task cannot be fetched → failed, no claim attempted', async () => {
    const { wm, calls } = fakeManager();
    const { d } = deps(wm, { getTask: async () => null });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_FAILED);
    expect(calls).not.toContain('claimAndStart');
  });

  test('session error → failed code, still flushes', async () => {
    const { wm, calls } = fakeManager({ statuses: ['working', 'error'] });
    const { d, flushed } = deps(wm);
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_FAILED);
    expect(calls).toContain('flushToServer');
    expect(flushed.length).toBeGreaterThan(0);
  });

  test('waiting for input: keeps waiting while the user may answer, then completes', async () => {
    const { wm, calls } = fakeManager({ statuses: ['working', 'waiting', 'waiting', 'waiting', 'working', 'done'] });
    const { d } = deps(wm, { maxWaitMs: 10_000, pollMs: 1_000 });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_COMPLETED);
    expect(calls).not.toContain('abort');
  });

  test('waiting for input past the max wait → aborts the worker and exits failed', async () => {
    const { wm, aborted } = fakeManager({ statuses: ['working', 'waiting'] });
    const { d } = deps(wm, { maxWaitMs: 5_000, pollMs: 1_000 });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_FAILED);
    expect(aborted).toHaveLength(1);
    expect(aborted[0].id).toBe('worker-1');
    expect(aborted[0].reason).toMatch(/input/i);
  });

  test('the wait clock resets when the worker resumes', async () => {
    // 4s waiting, resume, 4s waiting, done — never 5s continuous.
    const { wm, calls } = fakeManager({ statuses: ['waiting', 'waiting', 'waiting', 'waiting', 'working', 'waiting', 'waiting', 'waiting', 'waiting', 'done'] });
    const { d } = deps(wm, { maxWaitMs: 5_000, pollMs: 1_000 });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_COMPLETED);
    expect(calls).not.toContain('abort');
  });

  test('shuts down the broker and tears down the manager on every path', async () => {
    for (const statuses of [['done'], ['error']] as Status[][]) {
      let shut = 0;
      const { wm, calls } = fakeManager({ statuses });
      const { d } = deps(wm, { shutdown: async () => { shut++; } });
      await runOnce({ taskId: TASK_ID }, d);
      expect(shut).toBe(1);
      expect(calls).toContain('destroy');
    }
  });
});

describe('classifyClaimFailure', () => {
  test('server_rejected and 4xx refusals are refused; workspace_not_found, 408/429, 5xx and network are failed', () => {
    expect(classifyClaimFailure(Object.assign(new Error(''), { claimError: 'server_rejected' }))).toBe('refused');
    expect(classifyClaimFailure(Object.assign(new Error(''), { claimError: 'workspace_not_found' }))).toBe('failed');
    expect(classifyClaimFailure(new Error('API error: 403 - {"error":"forbidden"}'))).toBe('refused');
    expect(classifyClaimFailure(new Error('API error: 429 - {}'))).toBe('failed');
    expect(classifyClaimFailure(new Error('API error: 408 - {}'))).toBe('failed');
    expect(classifyClaimFailure(new Error('API error: 500 - {}'))).toBe('failed');
    expect(classifyClaimFailure(new TypeError('fetch failed'))).toBe('failed');
  });
});

describe('buildOnceConfig', () => {
  const base: any = { projectRoots: [], builddServer: 'https://example.test', apiKey: 'k', maxConcurrent: 3, acceptRemoteTasks: true, localUiUrl: 'http://localhost:8766' };

  test('turns off everything that would pick up other work', () => {
    const c = buildOnceConfig(base, { taskId: TASK_ID, host: 'box' });
    expect(c.singleTask).toBe(true);
    expect(c.acceptRemoteTasks).toBe(false);
    expect(c.maxConcurrent).toBe(1);
    // Headless, and a heartbeat key of its own so it never overwrites a
    // long-running runner's record on the same host.
    expect(c.localUiUrl?.startsWith('headless://box/')).toBe(true);
    expect(c.localUiUrl).toContain(TASK_ID);
    // Input is not mutated.
    expect(base.acceptRemoteTasks).toBe(true);
  });
});

describe('createOnceResolver', () => {
  const base: any = {
    resolve: (ws: any) => (ws.name === 'local' ? '/repos/local' : null),
    debugResolve: () => ({}), listLocalDirectories: () => [], getPathOverrides: () => ({}),
    setPathOverride: () => {}, scanGitRepos: () => [], getProjectRoots: () => [],
  };

  test('uses a local checkout when one resolves', () => {
    const clones: any[] = [];
    const r = createOnceResolver(base, '/iso', (ws, root) => { clones.push([ws, root]); return '/iso/x'; });
    expect(r.resolve({ id: 'a', name: 'local', repo: 'https://github.com/example/local' })).toBe('/repos/local');
    expect(clones).toHaveLength(0);
  });

  test('clones into the isolation root when nothing is checked out', () => {
    const clones: any[] = [];
    const r = createOnceResolver(base, '/iso', (ws, root) => { clones.push([ws, root]); return `/iso/${ws.id}`; });
    expect(r.resolve({ id: 'ws-9', name: 'remote', repo: 'https://github.com/example/remote' })).toBe('/iso/ws-9');
    expect(clones).toEqual([[{ id: 'ws-9', repo: 'https://github.com/example/remote' }, '/iso']]);
  });

  test('a failed clone resolves to null (claim path reports workspace_not_found)', () => {
    const r = createOnceResolver(base, '/iso', () => { throw new Error('clone failed'); });
    expect(r.resolve({ id: 'ws-9', name: 'remote', repo: 'https://github.com/example/remote' })).toBeNull();
  });

  test('no repo → no clone', () => {
    let cloned = false;
    const r = createOnceResolver(base, '/iso', () => { cloned = true; return '/x'; });
    expect(r.resolve({ id: 'ws-9', name: 'remote', repo: null })).toBeNull();
    expect(cloned).toBe(false);
  });
});

describe('resolveOnceMaxWaitMs', () => {
  test('defaults to 6h; honours a positive BUILDD_ONCE_MAX_WAIT_MS; ignores junk', () => {
    expect(DEFAULT_ONCE_MAX_WAIT_MS).toBe(6 * 60 * 60 * 1000);
    expect(resolveOnceMaxWaitMs({})).toBe(DEFAULT_ONCE_MAX_WAIT_MS);
    expect(resolveOnceMaxWaitMs({ BUILDD_ONCE_MAX_WAIT_MS: '120000' })).toBe(120_000);
    expect(resolveOnceMaxWaitMs({ BUILDD_ONCE_MAX_WAIT_MS: 'soon' })).toBe(DEFAULT_ONCE_MAX_WAIT_MS);
    expect(resolveOnceMaxWaitMs({ BUILDD_ONCE_MAX_WAIT_MS: '-5' })).toBe(DEFAULT_ONCE_MAX_WAIT_MS);
  });
});

describe('flushOutboxWithRetry', () => {
  test('retries until empty, bounded', async () => {
    let remaining = 2;
    const r = await flushOutboxWithRetry({ count: () => remaining, flush: async () => ({ remaining: --remaining }) }, { attempts: 5, delayMs: 1, sleep: async () => {} });
    expect(r).toBe(0);
  });

  test('gives up after the attempt budget and reports what is left', async () => {
    let n = 0;
    const r = await flushOutboxWithRetry({ count: () => 3, flush: async () => { n++; return { remaining: 3 }; } }, { attempts: 3, delayMs: 1, sleep: async () => {} });
    expect(n).toBe(3);
    expect(r).toBe(3);
  });

  test('no-op when already empty', async () => {
    let n = 0;
    const r = await flushOutboxWithRetry({ count: () => 0, flush: async () => { n++; return { remaining: 0 }; } }, { attempts: 3, delayMs: 1, sleep: async () => {} });
    expect(n).toBe(0);
    expect(r).toBe(0);
  });
});

describe('index.ts wiring', () => {
  // The long-running subsystems live at module scope in index.ts, so the only
  // way to keep --once from starting them is to dispatch before they are
  // reached. Pin the order.
  const src = readFileSync(join(import.meta.dir, '../../src/index.ts'), 'utf-8');
  const dispatch = src.indexOf('runOnceFromCli(');

  test('dispatches --once', () => {
    expect(dispatch).toBeGreaterThan(0);
  });

  for (const marker of [
    'new WorkerManager(',     // background claim loop + Pusher assignment
    'Bun.serve(',             // local UI server
    'initUpdateCanary(',      // update canary
    'initUpdateDrain(',       // update gate / drain
    'initCurrentCommit().then', // self-updater bookkeeping
    'credentialBroker.start(',
    'autoInstallMcp()',
  ]) {
    test(`before ${marker}`, () => {
      const at = src.indexOf(marker);
      expect(at).toBeGreaterThan(0);
      expect(dispatch).toBeLessThan(at);
    });
  }
});
