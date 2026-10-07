/**
 * Container reuse (container-lease.ts): lease naming and routing, the claim
 * decision, window expiry, max_instances accounting, and the supervisor's
 * handoff of a warm container to the next task, with the reset first and a
 * fresh container whenever the reset does not verify clean.
 *
 * The in-container half of the reset (what it discards and keeps) is tested
 * against a real filesystem, git and processes in
 * apps/runner/__tests__/unit/container-reset.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_REUSE_SLOTS,
  DEFAULT_REUSE_WINDOW_MS,
  MAX_INSTANCES,
  decideLeaseClaim,
  keepsContainerWarm,
  leaseName,
  parseLeaseName,
  resolveReuseSlots,
  resolveReuseWindowMs,
  routeToLease,
  savedRestoreMsOf,
  taskStateOnLease,
  type LeaseHandle,
  type LeaseKey,
  type LeasedDispatchRequest,
  type LeasedDispatchResult,
  type WarmContainer,
} from './container-lease';
import { INITIAL_STATE, RESET_OK_LINE, type RunState } from './lifecycle';
import { assembleRunReport } from './run-report';
import { TaskSupervisor, type ContainerPort, type ProcessPort, type SupervisorDeps } from './supervisor';

const WS = 'ws-1111';
const TASK_A = 'task-aaaa';
const TASK_B = 'task-bbbb';
const KEY: LeaseKey = { size: 'standard', workspaceId: WS, slot: 0 };
const WINDOW = 5 * 60 * 1000;

// ── Pure decisions ────────────────────────────────────────────────────────────

describe('lease names', () => {
  test('round-trip, and only for a workspace id and a known size', () => {
    expect(leaseName(WS, 'large', 1)).toBe(`lease:large:${WS}:1`);
    expect(parseLeaseName(leaseName(WS, 'large', 1))).toEqual({ size: 'large', workspaceId: WS, slot: 1 });
    // A task agent is named by its task ID: never a lease.
    expect(parseLeaseName(TASK_A)).toBeNull();
    expect(parseLeaseName(`lease:xl:${WS}:0`)).toBeNull();
    expect(parseLeaseName('lease:standard:../x:0')).toBeNull();
    expect(() => leaseName('../x', 'standard', 0)).toThrow();
  });
});

describe('config', () => {
  test('window defaults to five minutes and is clamped', () => {
    expect(resolveReuseWindowMs({})).toBe(DEFAULT_REUSE_WINDOW_MS);
    expect(resolveReuseWindowMs({ CONTAINER_REUSE_WINDOW_MS: '1000' })).toBe(30_000);
    expect(resolveReuseWindowMs({ CONTAINER_REUSE_WINDOW_MS: String(24 * 3600_000) })).toBe(30 * 60_000);
    expect(resolveReuseWindowMs({ CONTAINER_REUSE_WINDOW_MS: 'soon' })).toBe(DEFAULT_REUSE_WINDOW_MS);
  });

  test('slots never exceed the class\'s max_instances', () => {
    expect(resolveReuseSlots({}, 'standard')).toBe(DEFAULT_REUSE_SLOTS);
    expect(resolveReuseSlots({ CONTAINER_REUSE_SLOTS: '50' }, 'standard')).toBe(MAX_INSTANCES.standard);
    expect(resolveReuseSlots({ CONTAINER_REUSE_SLOTS: '50' }, 'large')).toBe(MAX_INSTANCES.large);
    expect(resolveReuseSlots({ CONTAINER_REUSE_SLOTS: '0' }, 'large')).toBe(DEFAULT_REUSE_SLOTS);
  });

  test('MAX_INSTANCES mirrors wrangler.jsonc max_instances per class', () => {
    const raw = readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf-8').replace(/^\s*\/\/.*$/gm, '');
    const containers = (JSON.parse(raw) as { containers: Array<{ class_name: string; max_instances: number }> }).containers;
    const by = Object.fromEntries(containers.map(c => [c.class_name, c.max_instances]));
    expect(MAX_INSTANCES.standard).toBe(by.WorkerAgent);
    expect(MAX_INSTANCES.large).toBe(by.WorkerAgentLarge);
  });
});

describe('decideLeaseClaim', () => {
  const now = 1_000_000;
  const warm: WarmContainer = { workspaceId: WS, size: 'standard', fromTaskId: TASK_A, since: now - 60_000, savedRestoreMs: 60_000 };
  const exited: RunState = { taskId: TASK_A, attempt: 1, status: 'exited', outcome: 'done', warm };
  const args = { key: KEY, workspaceId: WS, size: 'standard' as const, now, windowMs: WINDOW, containerRunning: true };

  test('warm: same workspace and size, inside the window, container up', () => {
    expect(decideLeaseClaim(exited, args)).toEqual({ claim: 'warm', warm });
  });

  test('cold: window over, container gone, or nothing kept', () => {
    expect(decideLeaseClaim(exited, { ...args, now: warm.since + WINDOW + 1 })).toEqual({ claim: 'cold' });
    expect(decideLeaseClaim(exited, { ...args, containerRunning: false })).toEqual({ claim: 'cold' });
    expect(decideLeaseClaim(INITIAL_STATE, args)).toEqual({ claim: 'cold' });
  });

  test('busy: a live run, a parked run waiting for its answer, a pending wake', () => {
    expect(decideLeaseClaim({ ...exited, status: 'running' }, args)).toEqual({ claim: 'busy', reason: 'live' });
    expect(decideLeaseClaim({ ...exited, status: 'starting' }, args)).toEqual({ claim: 'busy', reason: 'live' });
    expect(decideLeaseClaim({ ...exited, outcome: 'parked' }, args)).toEqual({ claim: 'busy', reason: 'parked' });
    expect(decideLeaseClaim({ ...exited, scheduleId: 's1' }, args)).toEqual({ claim: 'busy', reason: 'scheduled' });
  });

  test('never across workspaces or size classes', () => {
    expect(decideLeaseClaim(exited, { ...args, workspaceId: 'ws-other' })).toEqual({ claim: 'busy', reason: 'wrong_lease' });
    expect(decideLeaseClaim(exited, { ...args, size: 'large' })).toEqual({ claim: 'busy', reason: 'wrong_lease' });
    // A warm container left by another workspace's run (cannot happen by name, checked anyway).
    expect(decideLeaseClaim({ ...exited, warm: { ...warm, workspaceId: 'ws-other' } }, args)).toEqual({ claim: 'cold' });
  });

  test('only a run that ended done or failed keeps its container', () => {
    expect(keepsContainerWarm('done')).toBe(true);
    expect(keepsContainerWarm('failed')).toBe(true);
    for (const o of ['parked', 'crashed', 'usage', 'refused', 'deferred', 'start_deferred'] as const) expect(keepsContainerWarm(o)).toBe(false);
  });

  test('saved restore time sums what the previous run spent getting ready', () => {
    expect(savedRestoreMsOf({ durationsMs: { containerStart: 5_000, restoreWarm: 8_000, restoreCache: 52_000, clone: null } })).toBe(65_000);
    expect(savedRestoreMsOf({ durationsMs: { containerStart: null } })).toBeNull();
    expect(savedRestoreMsOf(undefined)).toBeNull();
  });
});

describe('routeToLease', () => {
  function leases(answers: Record<number, 'warm' | 'cold' | 'busy' | 'throws'>) {
    const asked: Array<{ name: string; warmOnly: boolean }> = [];
    const getLease = async (name: string): Promise<LeaseHandle> => {
      const slot = parseLeaseName(name)!.slot;
      return {
        async dispatchLeased(r: LeasedDispatchRequest): Promise<LeasedDispatchResult> {
          asked.push({ name, warmOnly: !!r.warmOnly });
          const a = answers[slot] ?? 'busy';
          if (a === 'throws') throw new Error('unreachable');
          if (a === 'busy' || (r.warmOnly && a !== 'warm')) return { accepted: false, reason: r.warmOnly && a === 'cold' ? 'not_warm' : 'busy', attempt: 0, status: 'idle' };
          return { accepted: true, attempt: 1, reused: a === 'warm' };
        },
      };
    };
    return { asked, getLease };
  }
  const args = { taskId: TASK_B, workspaceId: WS, size: 'standard' as const, slots: 3, request: {} };

  test('a warm slot wins over an earlier cold one', async () => {
    const l = leases({ 0: 'cold', 1: 'warm' });
    const r = await routeToLease({ getLease: l.getLease, log: () => {} }, args);
    expect(r?.lease).toBe(leaseName(WS, 'standard', 1));
    expect(r?.result.reused).toBe(true);
  });

  test('no warm slot: the first idle one', async () => {
    const l = leases({ 0: 'busy', 1: 'cold', 2: 'cold' });
    const r = await routeToLease({ getLease: l.getLease, log: () => {} }, args);
    expect(r?.lease).toBe(leaseName(WS, 'standard', 1));
    expect(r?.result.reused).toBe(false);
    expect(l.asked.filter(a => a.warmOnly)).toHaveLength(3);
  });

  test('every slot busy (or unreachable): null, the task runs in its own agent', async () => {
    const l = leases({ 0: 'busy', 1: 'throws', 2: 'busy' });
    expect(await routeToLease({ getLease: l.getLease, log: () => {} }, args)).toBeNull();
  });

  test('the lease is only ever of the task\'s workspace and size', async () => {
    const l = leases({ 0: 'cold' });
    await routeToLease({ getLease: l.getLease, log: () => {} }, { ...args, size: 'large', slots: 1 });
    expect(l.asked.every(a => a.name === leaseName(WS, 'large', 0))).toBe(true);
  });
});

// ── Supervisor handoff ────────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(`${l}\n`)); c.close(); } });
}

function leaseHarness(opts: { reset?: { code: number; lines: string[] } | 'throws' } = {}) {
  let state: RunState = INITIAL_STATE;
  let clock = 1_000_000;
  let running = false;
  const calls: string[] = [];
  const execs: Array<{ cmd: string[]; env?: Record<string, string> }> = [];
  const exits: Array<ReturnType<typeof deferred<number>>> = [];
  const pending: Promise<unknown>[] = [];
  const expiries: number[] = [];
  const egressFor: string[] = [];
  let died = deferred<void>();
  const container: ContainerPort = {
    get running() { return running; },
    start() { calls.push('start'); running = true; died = deferred<void>(); },
    async exec(cmd, o) {
      execs.push({ cmd, env: o?.env });
      if (cmd[1] === '--reset-container') {
        calls.push('reset');
        const r = opts.reset ?? { code: 0, lines: ['[reset] killed 3 process(es)', RESET_OK_LINE] };
        if (r === 'throws') throw new Error('exec failed');
        const p: ProcessPort = { stdout: streamOf(r.lines), stderr: streamOf([]), exitCode: Promise.resolve(r.code) };
        return p;
      }
      calls.push('exec');
      const exit = deferred<number>();
      exits.push(exit);
      return { stdout: streamOf([]), stderr: streamOf([]), exitCode: exit.promise };
    },
    monitor() { return died.promise; },
    async destroy() { calls.push('destroy'); running = false; died.resolve(); },
    async setInactivityTimeout() {},
  };
  const deps: SupervisorDeps = {
    get taskId() { return state.taskId ?? ''; },
    getState: () => state,
    setState: (s) => { state = s; },
    container,
    config: {
      BUILDD_SERVER: 'http://127.0.0.1:9',
      BUILDD_API_KEY: 'bld_runner_key',
      inactivityTimeoutMs: 1_800_000,
      startTimeoutMs: 1_000,
      lease: KEY,
      reuseWindowMs: WINDOW,
    },
    keepAliveWhile: (fn) => fn(),
    waitUntil: (p) => { pending.push(p); },
    installEgress: async () => { calls.push('installEgress'); egressFor.push(state.taskId ?? ''); },
    // One token per task: what the container of task B must never hold is A's.
    mintTaskToken: async () => { calls.push('mint'); return `bldt_token_for_${state.taskId}`; },
    fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    scheduler: { scheduleAt: async () => 's1', cancel: async () => {} },
    scheduleWarmExpiry: async (at) => { expiries.push(at); },
    now: () => clock,
    sleep: () => new Promise(r => setTimeout(r, 1)),
    log: () => {},
  };
  const sup = new TaskSupervisor(deps);
  return {
    sup, calls, execs, exits, expiries, egressFor, container,
    get state() { return state; },
    get running() { return running; },
    advance(ms: number) { clock += ms; },
    async settle() { await Promise.all(pending.splice(0)); },
    async until(pred: () => boolean) {
      for (let i = 0; i < 500 && !pred(); i++) await new Promise(r => setTimeout(r, 1));
      if (!pred()) throw new Error('condition never held');
    },
    /** Dispatch `taskId`, let it reach `running`, exit it with `code`, and wait for the cleanup. */
    async runTask(taskId: string, code: number) {
      const r = sup.dispatchLeased({ taskId, workspaceId: WS });
      expect(r.accepted).toBe(true);
      await this.until(() => state.status === 'running');
      clock += 30_000;
      exits[exits.length - 1]!.resolve(code);
      await this.until(() => state.status === 'exited');
      await this.settle();
      return r;
    },
  };
}

describe('supervisor: a lease hands its warm container to the next task', () => {
  test('a run that ended done keeps the container and schedules its expiry', async () => {
    const h = leaseHarness();
    await h.runTask(TASK_A, 0);
    expect(h.calls).not.toContain('destroy');
    expect(h.running).toBe(true);
    expect(h.state.warm).toMatchObject({ workspaceId: WS, size: 'standard', fromTaskId: TASK_A });
    expect(h.expiries).toEqual([h.state.warm!.since + WINDOW]);
    expect(h.state.report?.reusedContainer).toBeNull();
  });

  test('the next task runs in it: reset first with no token, then its own token and egress, no new container', async () => {
    const h = leaseHarness();
    await h.runTask(TASK_A, 0);
    const starts = h.calls.filter(c => c === 'start').length;
    h.advance(45_000);
    const r = await h.runTask(TASK_B, 0);
    expect(r).toMatchObject({ accepted: true, attempt: 1, reused: true });
    expect(h.calls.filter(c => c === 'start').length).toBe(starts);

    // Order for B: reset, then mint, then egress, then the runner.
    const b = h.calls.slice(h.calls.lastIndexOf('reset'));
    expect(b.slice(0, 4)).toEqual(['reset', 'mint', 'installEgress', 'exec']);
    // The reset holds no task token at all; B's runner holds B's, never A's.
    const resetExec = h.execs.find(e => e.cmd[1] === '--reset-container')!;
    expect(Object.values(resetExec.env ?? {}).some(v => v.startsWith('bldt_'))).toBe(false);
    expect(resetExec.env?.BUILDD_API_KEY).toBeUndefined();
    const bRun = h.execs.filter(e => e.cmd[0] === 'buildd-once' && e.cmd[1] === '--task').pop()!;
    expect(bRun.cmd).toEqual(['buildd-once', '--task', TASK_B]);
    expect(bRun.env?.BUILDD_API_KEY).toBe(`bldt_token_for_${TASK_B}`);
    expect(JSON.stringify(bRun.env)).not.toContain(`bldt_token_for_${TASK_A}`);
    // Egress re-installed for B's task.
    expect(h.egressFor.at(-1)).toBe(TASK_B);

    expect(h.state.taskId).toBe(TASK_B);
    expect(h.state.report?.taskId).toBe(TASK_B);
    expect(h.state.report?.attempt).toBe(1);
    expect(h.state.report?.reusedContainer).toEqual({ fromTaskId: TASK_A, idleMs: 45_000, savedRestoreMs: expect.any(Number) });
    // A's report is kept, under A.
    expect(h.state.reportHistory?.map(rep => rep.taskId)).toEqual([TASK_A]);
  });

  for (const [why, reset] of [
    ['exits non-zero', { code: 1, lines: ['BUILDD_RESET=failed left behind: /home/bun/.claude'] }],
    ['exits 0 without the ok line', { code: 0, lines: [] }],
    ['cannot even be exec\'d', 'throws'],
  ] as const) {
    test(`a reset that ${why} replaces the container: never runs dirty`, async () => {
      const h = leaseHarness({ reset });
      await h.runTask(TASK_A, 0);
      const before = h.calls.length;
      await h.runTask(TASK_B, 0);
      const b = h.calls.slice(before);
      // destroy before the fresh start, and the runner only in the fresh container
      expect(b.indexOf('destroy')).toBeGreaterThan(-1);
      expect(b.indexOf('destroy')).toBeLessThan(b.indexOf('start'));
      expect(b.indexOf('start')).toBeLessThan(b.indexOf('exec'));
      expect(h.state.report?.reusedContainer).toMatchObject({ fromTaskId: TASK_A, fallback: 'reset_failed', savedRestoreMs: null });
    });
  }

  test('a container that died while warm is not reused (fresh start, no reset)', async () => {
    const h = leaseHarness();
    await h.runTask(TASK_A, 0);
    await h.sup.expireWarmContainer(); // inside the window: no-op
    expect(h.running).toBe(true);
    // The platform stopped it meanwhile.
    await h.container.destroy();
    await h.runTask(TASK_B, 0);
    expect(h.calls).not.toContain('reset');
    expect(h.state.report?.reusedContainer).toBeNull();
  });

  test('the window: expiry destroys the warm container after it, a later dispatch is cold', async () => {
    const h = leaseHarness();
    await h.runTask(TASK_A, 0);
    expect(await h.sup.expireWarmContainer()).toEqual({ expired: false });
    h.advance(WINDOW + 1);
    expect(await h.sup.expireWarmContainer()).toEqual({ expired: true });
    expect(h.running).toBe(false);
    expect(h.state.warm).toBeUndefined();
    await h.runTask(TASK_B, 0);
    expect(h.calls).not.toContain('reset');
    expect(h.state.report?.reusedContainer).toBeNull();
  });

  test('a parked run releases its container and holds the lease for its own resume', async () => {
    const h = leaseHarness();
    await h.runTask(TASK_A, 4);
    expect(h.state.outcome).toBe('parked');
    expect(h.running).toBe(false);
    expect(h.state.warm).toBeUndefined();
    expect(h.sup.dispatchLeased({ taskId: TASK_B, workspaceId: WS })).toMatchObject({ accepted: false, reason: 'busy' });
    // Another task's resume can never land here.
    expect(h.sup.dispatchLeased({ taskId: TASK_B, workspaceId: WS, resumeWorkerId: 'w-1' })).toMatchObject({ accepted: false, reason: 'not_parked' });
  });

  test('a crashed run does not keep its container', async () => {
    const h = leaseHarness();
    await h.runTask(TASK_A, 137);
    expect(h.state.outcome).toBe('crashed');
    expect(h.running).toBe(false);
    expect(h.state.warm).toBeUndefined();
  });

  test('one task at a time: a second task while one is live is refused, a duplicate is already_live', async () => {
    const h = leaseHarness();
    h.sup.dispatchLeased({ taskId: TASK_A, workspaceId: WS });
    await h.until(() => h.state.status === 'running');
    expect(h.sup.dispatchLeased({ taskId: TASK_B, workspaceId: WS })).toMatchObject({ accepted: false, reason: 'busy' });
    expect(h.sup.dispatchLeased({ taskId: TASK_A, workspaceId: WS })).toMatchObject({ accepted: false, reason: 'already_live' });
    h.exits[0]!.resolve(0);
    await h.until(() => h.state.status === 'exited');
    await h.settle();
  });

  test('another workspace never gets the lease', async () => {
    const h = leaseHarness();
    await h.runTask(TASK_A, 0);
    expect(h.sup.dispatchLeased({ taskId: TASK_B, workspaceId: 'ws-other' })).toMatchObject({ accepted: false, reason: 'busy' });
    expect(h.state.taskId).toBe(TASK_A);
  });

  test('warmOnly takes a warm lease and refuses a cold one', async () => {
    const h = leaseHarness();
    expect(h.sup.dispatchLeased({ taskId: TASK_A, workspaceId: WS, warmOnly: true })).toMatchObject({ accepted: false, reason: 'not_warm' });
    expect(h.state.taskId).toBeNull();
    await h.runTask(TASK_A, 0);
    expect(h.sup.dispatchLeased({ taskId: TASK_B, workspaceId: WS, warmOnly: true })).toMatchObject({ accepted: true, reused: true });
    await h.until(() => h.state.status === 'running');
    h.exits.at(-1)!.resolve(0);
    await h.until(() => h.state.status === 'exited');
    await h.settle();
  });

  test('a task agent (no lease) takes no leased dispatch', async () => {
    const h = leaseHarness();
    (h.sup as unknown as { d: SupervisorDeps }).d.config.lease = undefined;
    expect(h.sup.dispatchLeased({ taskId: TASK_A, workspaceId: WS })).toMatchObject({ accepted: false, reason: 'busy' });
  });
});

describe('taskStateOnLease (GET /tasks/:id for a task on a lease)', () => {
  const LEASE = leaseName(WS, 'standard', 0);
  const rep = (taskId: string, attempt: number) => assembleRunReport({ taskId, attempt, workerId: `w-${taskId}`, outcome: 'done' });
  const own: RunState = { taskId: TASK_A, attempt: 0, status: 'idle', leasedTo: LEASE };

  test('the lease still has the task: its state, without the warm container or other tasks\' reports', () => {
    const lease: RunState = {
      taskId: TASK_A, attempt: 1, status: 'running',
      warm: { workspaceId: WS, size: 'standard', fromTaskId: 'task-zzzz', since: 1, savedRestoreMs: null },
      reportHistory: [{ ...rep('task-zzzz', 1), delivery: 'sent' }],
    };
    const v = taskStateOnLease(TASK_A, LEASE, lease, own);
    expect(v).toMatchObject({ taskId: TASK_A, status: 'running', leasedTo: LEASE });
    expect(v.warm).toBeUndefined();
    expect(v.reportHistory).toBeUndefined();
  });

  test('the lease moved on: the task\'s last report there (a resume still finds its park)', () => {
    const lease: RunState = { taskId: TASK_B, attempt: 1, status: 'running', reportHistory: [{ ...rep(TASK_A, 1), outcome: 'parked', delivery: 'sent' }] };
    expect(taskStateOnLease(TASK_A, LEASE, lease, own)).toMatchObject({ taskId: TASK_A, status: 'exited', outcome: 'parked', workerId: `w-${TASK_A}`, leasedTo: LEASE });
    expect(taskStateOnLease('task-none', LEASE, lease, { ...own, taskId: 'task-none' })).toEqual({ taskId: 'task-none', attempt: 0, status: 'idle', leasedTo: LEASE });
  });
});

describe('run report: reusedContainer', () => {
  test('sanitized: an id that is not one (or looks like a credential) drops the section', () => {
    const base = { taskId: TASK_B, attempt: 1 };
    expect(assembleRunReport(base).reusedContainer).toBeNull();
    expect(assembleRunReport({ ...base, reusedContainer: { fromTaskId: TASK_A, idleMs: 1.7, savedRestoreMs: 65_000.4 } }).reusedContainer)
      .toEqual({ fromTaskId: TASK_A, idleMs: 1, savedRestoreMs: 65_000 });
    expect(assembleRunReport({ ...base, reusedContainer: { fromTaskId: TASK_A, idleMs: 5, savedRestoreMs: null, fallback: 'reset_failed' } }).reusedContainer)
      .toEqual({ fromTaskId: TASK_A, idleMs: 5, savedRestoreMs: null, fallback: 'reset_failed' });
    expect(assembleRunReport({ ...base, reusedContainer: { fromTaskId: 'bldt_secret', idleMs: 5, savedRestoreMs: null } }).reusedContainer).toBeNull();
  });
});
