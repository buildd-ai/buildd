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
  runResume,
  unrestoredResumeAction,
  runParkOrphan,
  pidsToStop,
  parseOnceArgs,
  EXIT_PARKED,
  PARKED_LINE_PREFIX,
  RESUMED_LINE_PREFIX,
  CLAIM_DEFERRED_LINE_PREFIX,
  type ResumePort,
  buildOnceConfig,
  classifyClaimFailure,
  createOnceResolver,
  resolveOnceMaxWaitMs,
  flushOutboxWithRetry,
  EXIT_COMPLETED,
  EXIT_FAILED,
  EXIT_CLAIM_REFUSED,
  EXIT_CLAIM_DEFERRED,
  EXIT_USAGE,
  DEFAULT_ONCE_MAX_WAIT_MS,
  WORKER_ID_LINE_PREFIX,
  type RunOnceDeps,
  type OnceWorkerManager,
} from '../../src/run-once';
import { withFleetIdentity } from '../../src/fleet-identity';
import { GitCloneError } from '../../src/git-clone';

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
    const codes = [EXIT_COMPLETED, EXIT_FAILED, EXIT_CLAIM_REFUSED, EXIT_CLAIM_DEFERRED, EXIT_PARKED, EXIT_USAGE];
    expect(EXIT_PARKED).toBe(4);
    expect(EXIT_CLAIM_DEFERRED).toBe(5);
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

  test('--resume-worker <id> continues a parked worker (the task id is optional)', () => {
    expect(parseOnceArgs(['bun', 'index.ts', '--once', '--resume-worker', 'w-1', '--task', TASK_ID]))
      .toEqual({ once: true, taskId: TASK_ID, resumeWorkerId: 'w-1' });
    expect(parseOnceArgs(['bun', 'index.ts', '--once', '--resume-worker', 'w-1']))
      .toEqual({ once: true, taskId: '', resumeWorkerId: 'w-1' });
  });

  test('--park-orphan <id> --task <id>', () => {
    expect(parseOnceArgs(['bun', 'index.ts', '--once', '--park-orphan', 'w-1', '--task', TASK_ID]))
      .toEqual({ once: true, taskId: TASK_ID, parkOrphanWorkerId: 'w-1' });
    expect('error' in parseOnceArgs(['bun', 'index.ts', '--once', '--park-orphan', 'w-1'])).toBe(true);
  });

  test('worker ids that could be flags or paths are usage errors', () => {
    for (const bad of ['--x', '../w', 'a/b']) {
      expect('error' in parseOnceArgs(['bun', 'index.ts', '--once', '--resume-worker', bad])).toBe(true);
    }
    expect('error' in parseOnceArgs(['bun', 'index.ts', '--once', '--resume-worker', 'w', '--park-orphan', 'w', '--task', 't'])).toBe(true);
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

  test('claim deferred for capacity (workspace_cap) → deferred code, prints the reason line, no session', async () => {
    const { wm, calls } = fakeManager({
      claim: async () => { throw Object.assign(new Error('rejected'), { claimError: 'server_rejected', claimReason: 'no_pending_tasks', claimTaskExclusionCode: 'workspace_cap' }); },
    });
    const lines: string[] = [];
    const { d } = deps(wm, { log: (m) => lines.push(m) });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_CLAIM_DEFERRED);
    expect(calls).not.toContain('abort');
    expect(calls).toContain('destroy');
    expect(lines).toContain(`${CLAIM_DEFERRED_LINE_PREFIX}workspace_cap`);
  });

  test('claim deferred by the account-wide cap (bare HTTP 429) → deferred code', async () => {
    const { wm } = fakeManager({
      claim: async () => { throw Object.assign(new Error('API error: 429 - {}'), { name: 'ServerRefusalError', status: 429 }); },
    });
    const { d } = deps(wm);
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_CLAIM_DEFERRED);
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

describe('park on waiting_input (BUILDD_ONCE_PARK)', () => {
  test('a waiting worker with no live session is parked once: BUILDD_PARKED line, exit 4, no abort', async () => {
    const { wm, calls, aborted } = fakeManager({ statuses: ['working', 'waiting'] });
    const logs: string[] = [];
    const parks: string[] = [];
    const ends: string[] = [];
    const { d } = deps(wm, {
      log: (m) => logs.push(m),
      park: async (id) => { parks.push(id); return true; },
      afterRun: async (o) => { ends.push(o); },
    });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_PARKED);
    expect(parks).toEqual(['worker-1']);
    expect(logs).toContain(`${PARKED_LINE_PREFIX}worker-1`);
    expect(aborted).toHaveLength(0);
    expect(ends).toEqual(['parked']);
    expect(calls).toContain('flushToServer');
  });

  test('a waiting worker whose session is still live (a permission prompt) is not parked', async () => {
    const { wm } = fakeManager({ statuses: ['waiting', 'waiting', 'waiting', 'done'], liveSessionPolls: 3 });
    const parks: string[] = [];
    const { d } = deps(wm, { park: async (id) => { parks.push(id); return true; } });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_COMPLETED);
    expect(parks).toEqual([]);
  });

  test('a park that fails keeps waiting as before, and is not retried every poll', async () => {
    const { wm } = fakeManager({ statuses: ['waiting'] });
    let tries = 0;
    const { d } = deps(wm, { maxWaitMs: 5_000, park: async () => { tries++; return false; } });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_FAILED);
    expect(tries).toBe(1);
  });

  test('without a park dep (flag off), nothing changes', async () => {
    const { wm } = fakeManager({ statuses: ['waiting'] });
    const { d } = deps(wm, { maxWaitMs: 2_000 });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_FAILED);
  });
});

describe('runResume (--resume-worker)', () => {
  function resumePort(over: Partial<ResumePort> = {}) {
    const calls: string[] = [];
    const port: ResumePort = {
      restore: async () => { calls.push('restore'); return { ok: true, kind: 'waiting' }; },
      reattach: async () => { calls.push('reattach'); return 'ok'; },
      unpark: async () => { calls.push('unpark'); },
      settleUnrestored: async () => { calls.push('settle'); },
      adopt: async () => { calls.push('adopt'); return true; },
      discardBundle: async () => { calls.push('discard'); },
      ...over,
    };
    return { port, calls };
  }

  test('restore → reattach → adopt, then runs to completion on the SAME worker and drops the bundle', async () => {
    const { wm, calls: wmCalls } = fakeManager({ statuses: ['waiting', 'working', 'done'] });
    const logs: string[] = [];
    const { port, calls } = resumePort();
    const { d } = deps(wm, { log: (m) => logs.push(m) });
    expect(await runResume({ workerId: 'worker-7' }, { ...d, resume: port })).toBe(EXIT_COMPLETED);
    expect(calls).toEqual(['restore', 'reattach', 'adopt', 'discard']);
    expect(wmCalls).not.toContain('claimAndStart');
    expect(logs).toContain(`${WORKER_ID_LINE_PREFIX}worker-7`);
    expect(logs).toContain(`${RESUMED_LINE_PREFIX}worker-7`);
  });

  test('restore failure: no re-attach; the park is cleared, then the worker is settled (failed unless an answer is waiting)', async () => {
    const { wm } = fakeManager();
    const settled: Array<[string, string, string | undefined]> = [];
    const { port, calls } = resumePort({
      restore: async () => { calls.push('restore'); return { ok: false, reason: 'bundle missing', kind: 'orphan' }; },
      settleUnrestored: async (id, reason, kind) => { calls.push('settle'); settled.push([id, reason, kind]); },
    });
    const { d } = deps(wm);
    expect(await runResume({ workerId: 'worker-7' }, { ...d, resume: port })).toBe(EXIT_FAILED);
    expect(calls).toEqual(['restore', 'unpark', 'settle']);
    expect(settled).toEqual([['worker-7', 'bundle missing', 'orphan']]);
  });

  test('a throwing restore is settled the same way (kind unknown)', async () => {
    const { wm } = fakeManager();
    const settled: Array<string | undefined> = [];
    const { port } = resumePort({
      restore: async () => { throw new Error('boom'); },
      settleUnrestored: async (_id, _reason, kind) => { settled.push(kind); },
    });
    const { d } = deps(wm);
    expect(await runResume({ workerId: 'worker-7' }, { ...d, resume: port })).toBe(EXIT_FAILED);
    expect(settled).toEqual([undefined]);
  });

  test('a settle that throws does not change the exit code', async () => {
    const { wm } = fakeManager();
    const { port } = resumePort({
      restore: async () => ({ ok: false, reason: 'x' }),
      settleUnrestored: async () => { throw new Error('network'); },
    });
    const { d } = deps(wm);
    expect(await runResume({ workerId: 'worker-7' }, { ...d, resume: port })).toBe(EXIT_FAILED);
  });
});

describe('unrestoredResumeAction: what a failed resume does with the worker', () => {
  test('an answer is waiting (waiting_input): leave it, the ack-deadline sweep degrades it into a cold continuation', () => {
    expect(unrestoredResumeAction('waiting_input', 'waiting')).toBe('leave');
    expect(unrestoredResumeAction('waiting_input', undefined)).toBe('leave');
  });

  test('an orphan park (still running, nothing queued, nothing will ever drive it): fail it', () => {
    expect(unrestoredResumeAction('running', 'orphan')).toBe('fail');
    expect(unrestoredResumeAction('running', undefined)).toBe('fail');
  });

  test('already terminal: nothing to do', () => {
    for (const s of ['completed', 'failed', 'superseded']) expect(unrestoredResumeAction(s, 'orphan')).toBe('leave');
  });

  test('status unknown (the lookup failed): fail only what is known to be an orphan', () => {
    expect(unrestoredResumeAction(null, 'orphan')).toBe('fail');
    expect(unrestoredResumeAction(null, 'waiting')).toBe('leave');
    expect(unrestoredResumeAction(null, undefined)).toBe('leave');
  });
});

test('the CLI wiring settles an unrestored worker from its server status, through the normal failed PATCH', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/run-once.ts'), 'utf-8');
  const wiring = src.slice(src.indexOf('settleUnrestored: async (workerId, reason, kind) =>'));
  expect(wiring).toContain('client.getWorkerRemote(workerId)');
  expect(wiring).toContain("unrestoredResumeAction(remote?.status, kind) !== 'fail'");
  expect(wiring).toMatch(/client\.updateWorker\(workerId, \{\s*status: 'failed'/);
  // The manifest's kind reaches a failure that happens after it was read.
  expect(src).toContain("return { ok: false, reason: err instanceof Error ? err.message : String(err), kind };");
});

describe('runResume (--resume-worker), continued', () => {
  function resumePort(over: Partial<ResumePort> = {}) {
    const calls: string[] = [];
    const port: ResumePort = {
      restore: async () => { calls.push('restore'); return { ok: true, kind: 'waiting' }; },
      reattach: async () => { calls.push('reattach'); return 'ok'; },
      unpark: async () => { calls.push('unpark'); },
      settleUnrestored: async () => { calls.push('settle'); },
      adopt: async () => { calls.push('adopt'); return true; },
      discardBundle: async () => { calls.push('discard'); },
      ...over,
    };
    return { port, calls };
  }

  test('re-attach refused (another container won, or expired): exit 3, nothing adopted', async () => {
    const { wm } = fakeManager();
    const { port, calls } = resumePort({ reattach: async () => { calls.push('reattach'); return 'refused'; } });
    const { d } = deps(wm);
    expect(await runResume({ workerId: 'worker-7' }, { ...d, resume: port })).toBe(EXIT_CLAIM_REFUSED);
    expect(calls).toEqual(['restore', 'reattach']);
  });

  test('a resumed worker that asks again parks again (and keeps its bundle)', async () => {
    const { wm } = fakeManager({ statuses: ['waiting', 'working', 'waiting'] });
    // The first poll after adopt sees `waiting` before the queued answer is drained;
    // only a wait after the worker ran again may park.
    const { port, calls } = resumePort();
    const parks: string[] = [];
    const { d } = deps(wm, { park: async (id) => { parks.push(id); return true; } });
    expect(await runResume({ workerId: 'worker-7' }, { ...d, resume: port })).toBe(EXIT_PARKED);
    expect(parks).toEqual(['worker-7']);
    expect(calls).not.toContain('discard');
  });
});

describe('runParkOrphan (--park-orphan)', () => {
  test('stops the orphaned runner first, then parks from disk: exit 4', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    const code = await runParkOrphan({ workerId: 'w-9' }, {
      stopOthers: () => { order.push('stop'); },
      parkFromDisk: async (id) => { order.push(`park:${id}`); return true; },
      log: (m) => logs.push(m),
    });
    expect(code).toBe(EXIT_PARKED);
    expect(order).toEqual(['stop', 'park:w-9']);
    expect(logs).toContain(`${PARKED_LINE_PREFIX}w-9`);
  });

  test('a park that fails exits 1 (the agent falls back to the crash report)', async () => {
    expect(await runParkOrphan({ workerId: 'w-9' }, { stopOthers: () => {}, parkFromDisk: async () => false, log: () => {} })).toBe(EXIT_FAILED);
    expect(await runParkOrphan({ workerId: 'w-9' }, { stopOthers: () => {}, parkFromDisk: async () => { throw new Error('x'); }, log: () => {} })).toBe(EXIT_FAILED);
  });
});

describe('pidsToStop (--park-orphan)', () => {
  // The container: tini (1) runs `sleep infinity` (7) as its main process, all
  // as the image user. The orphaned runner was exec'd (ppid 0) with Claude Code
  // under it; this process was exec'd later by the restarted agent.
  const UID = 1000;
  const procs = [
    { pid: 1, ppid: 0, uid: UID, startTime: 100 },
    { pid: 7, ppid: 1, uid: UID, startTime: 101 },
    { pid: 40, ppid: 0, uid: UID, startTime: 500 },
    { pid: 41, ppid: 40, uid: UID, startTime: 510 },
    { pid: 42, ppid: 41, uid: UID, startTime: 520 },
    { pid: 55, ppid: 1, uid: UID, startTime: 600 }, // reparented grandchild of the old runner
    { pid: 60, ppid: 0, uid: 0, startTime: 700 }, // someone else's
    { pid: 90, ppid: 0, uid: UID, startTime: 900 }, // buildd-once.sh for this park
    { pid: 91, ppid: 90, uid: UID, startTime: 901 }, // this process
  ];

  test("stops the orphaned runner's tree and strays, never the container's main process", () => {
    expect(pidsToStop(procs, 91, UID).sort((a, b) => a - b)).toEqual([40, 41, 42, 55]);
  });

  test('keeps init, its first child, this process and its ancestors', () => {
    const stop = pidsToStop(procs, 91, UID);
    for (const keep of [1, 7, 90, 91]) expect(stop).not.toContain(keep);
  });

  test("never another user's process", () => {
    expect(pidsToStop(procs, 91, UID)).not.toContain(60);
  });
});

describe('runOnce afterRun hook (warm-repo refresh)', () => {
  test.each([
    [['working', 'done'] as Status[], 'completed'],
    [['working', 'error'] as Status[], 'failed'],
  ])('called once with the outcome, before the final flush', async (statuses, want) => {
    const { wm, calls } = fakeManager({ statuses });
    const seen: string[] = [];
    const { d } = deps(wm, { afterRun: async (o) => { seen.push(o); calls.push('afterRun'); } });
    await runOnce({ taskId: TASK_ID }, d);
    expect(seen).toEqual([want]);
    expect(calls.indexOf('afterRun')).toBeLessThan(calls.indexOf('flushToServer'));
  });

  test('wait timeout reports wait_timeout; a throwing hook does not change the exit code', async () => {
    const { wm } = fakeManager({ statuses: ['waiting'] });
    const seen: string[] = [];
    const { d } = deps(wm, { maxWaitMs: 2_000, afterRun: async (o) => { seen.push(o); throw new Error('boom'); } });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_FAILED);
    expect(seen).toEqual(['wait_timeout']);
  });

  test('not called when the claim is refused (nothing was cloned for this run)', async () => {
    const { wm } = fakeManager({ claim: async () => null });
    const seen: string[] = [];
    const { d } = deps(wm, { afterRun: async (o) => { seen.push(o); } });
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_CLAIM_REFUSED);
    expect(seen).toEqual([]);
  });

  test('run_end is marked once the outcome is known, before the after-run step (a lease waits on it)', async () => {
    const { wm, calls } = fakeManager({ statuses: ['working', 'done'] });
    const { d } = deps(wm, { emitRunEnd: () => { calls.push('runEnd'); }, afterRun: async () => { calls.push('afterRun'); } });
    await runOnce({ taskId: TASK_ID }, d);
    expect(calls.filter(c => c === 'runEnd')).toHaveLength(1);
    expect(calls.indexOf('runEnd')).toBeLessThan(calls.indexOf('afterRun'));
  });
});

describe('classifyClaimFailure', () => {
  test('server_rejected with no taskExclusion and 4xx refusals are refused; workspace_not_found, 408, 5xx and network are failed; 429 is deferred', () => {
    expect(classifyClaimFailure(Object.assign(new Error(''), { claimError: 'server_rejected' }))).toBe('refused');
    expect(classifyClaimFailure(Object.assign(new Error(''), { claimError: 'workspace_not_found' }))).toBe('failed');
    expect(classifyClaimFailure(new Error('API error: 403 - {"error":"forbidden"}'))).toBe('refused');
    // The account-wide cap (route.ts: activeWorkers.length >= maxConcurrentWorkers)
    // throws a bare 429 before any task-specific gate — the same capacity wall
    // as `no_slots`, just via a throw instead of an empty 200.
    expect(classifyClaimFailure(new Error('API error: 429 - {}'))).toBe('deferred');
    expect(classifyClaimFailure(new Error('API error: 408 - {}'))).toBe('failed');
    expect(classifyClaimFailure(new Error('API error: 500 - {}'))).toBe('failed');
    expect(classifyClaimFailure(new TypeError('fetch failed'))).toBe('failed');
  });

  test('server_rejected with a capacity/pacing taskExclusion code is deferred, not refused', () => {
    for (const code of ['workspace_cap', 'mission_concurrent', 'mission_paced', 'mission_budget', 'account_cap', 'path_overlap', 'budget_paused', 'oauth_parallelism', 'runner_capability', 'deps_blocked', 'state_changed', 'runner_cooldown']) {
      const err = Object.assign(new Error('rejected'), { claimError: 'server_rejected', claimReason: 'no_pending_tasks', claimTaskExclusionCode: code });
      expect(classifyClaimFailure(err)).toBe('deferred');
    }
  });

  test('a managed-runner entitlement block is a deferral (retry later), never a refusal or failure', () => {
    for (const code of ['managed_concurrency', 'managed_runner_hours', 'hosted_runner_hours']) {
      const err = Object.assign(new Error('rejected'), { claimError: 'server_rejected', claimReason: 'all_candidates_deferred', claimTaskExclusionCode: code });
      expect(classifyClaimFailure(err)).toBe('deferred');
    }
  });

  test('server_rejected with a structural taskExclusion code stays refused', () => {
    for (const code of ['already_claimed', 'active_worker', 'duplicate_worker', 'task_held', 'mission_held', 'mission_local', 'subject_dead', 'runner_preference', 'role_mismatch', 'workspace_executor', 'workspace_mismatch', 'capability_mismatch', 'not_found', 'not_pending']) {
      const err = Object.assign(new Error('rejected'), { claimError: 'server_rejected', claimReason: 'no_pending_tasks', claimTaskExclusionCode: code });
      expect(classifyClaimFailure(err)).toBe('refused');
    }
  });

  test('server_rejected with a top-level capacity reason and no taskExclusion is deferred', () => {
    for (const reason of ['no_slots', 'budget_exhausted', 'budget_exhausted_partial', 'context_paused', 'path_overlap_blocked', 'rate_limited', 'all_candidates_deferred']) {
      const err = Object.assign(new Error('rejected'), { claimError: 'server_rejected', claimReason: reason });
      expect(classifyClaimFailure(err)).toBe('deferred');
    }
  });

  test('server_rejected with no_pending_tasks and no taskExclusion stays refused (unchanged default)', () => {
    const err = Object.assign(new Error('rejected'), { claimError: 'server_rejected', claimReason: 'no_pending_tasks' });
    expect(classifyClaimFailure(err)).toBe('refused');
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

  test('a cloud container reports executor cloud, its dispatcher group, one slot, ephemeral', () => {
    const c = buildOnceConfig(base, { taskId: TASK_ID, host: 'box', env: { BUILDD_EXECUTOR: 'cloud', BUILDD_RUNNER_GROUP: 'my-dispatcher' } });
    expect(c.fleetIdentity).toEqual({ executor: 'cloud', ephemeral: true, concurrency: 1, group: 'my-dispatcher' });
  });

  test('a host --once run is ephemeral too, with no group', () => {
    const c = buildOnceConfig(base, { taskId: TASK_ID, host: 'box', env: { BUILDD_RUNNER_GROUP: 'ignored-off-cloud' } });
    expect(c.fleetIdentity).toEqual({ executor: 'host', ephemeral: true, concurrency: 1, group: null });
  });

  test('an unusable group name is dropped, not sent', () => {
    const c = buildOnceConfig(base, { taskId: TASK_ID, host: 'box', env: { BUILDD_EXECUTOR: 'cloud', BUILDD_RUNNER_GROUP: 'has spaces/and slashes' } });
    expect(c.fleetIdentity?.group).toBeNull();
  });
});

describe('heartbeat environment of a --once run', () => {
  test('the identity rides on the scanned environment', () => {
    const scanned: any = { tools: [], envKeys: ['browser'], mcp: [], labels: { hostname: 'box' }, scannedAt: 't' };
    const fleet = { executor: 'cloud' as const, ephemeral: true, concurrency: 1, group: 'g' };
    expect(withFleetIdentity(scanned, fleet)).toEqual({ ...scanned, fleet });
    expect(scanned.fleet).toBeUndefined();
  });

  test('before the scan finishes the identity is still sent', () => {
    const fleet = { executor: 'cloud' as const, ephemeral: true, concurrency: 1, group: 'g' };
    expect(withFleetIdentity(undefined, fleet)?.fleet).toEqual(fleet);
  });

  test('a long-lived runner sends its environment unchanged', () => {
    const scanned: any = { tools: [], envKeys: [], mcp: [], labels: {}, scannedAt: 't' };
    expect(withFleetIdentity(scanned, undefined)).toBe(scanned);
    expect(withFleetIdentity(undefined, undefined)).toBeUndefined();
  });
});

describe('runOnce — leaving the fleet', () => {
  test('sends a last heartbeat after the final sync and before teardown, so the run reads as ended', async () => {
    const { wm, calls } = fakeManager({ statuses: ['working', 'done'] });
    (wm as any).sendHeartbeatNow = async () => { calls.push('heartbeat'); };
    const { d } = deps(wm);
    await runOnce({ taskId: TASK_ID }, d);
    expect(calls).toContain('heartbeat');
    expect(calls.indexOf('flushToServer')).toBeLessThan(calls.indexOf('heartbeat'));
    expect(calls.indexOf('heartbeat')).toBeLessThan(calls.indexOf('destroy'));
  });

  test('a failing last heartbeat never blocks teardown', async () => {
    const { wm, calls } = fakeManager({ statuses: ['working', 'done'] });
    (wm as any).sendHeartbeatNow = async () => { throw new Error('offline'); };
    const { d } = deps(wm);
    expect(await runOnce({ taskId: TASK_ID }, d)).toBe(EXIT_COMPLETED);
    expect(calls).toContain('destroy');
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

  test('preferIsolated (warm repos on): the isolated clone wins over any local checkout or auto-clone', () => {
    const clones: any[] = [];
    const r = createOnceResolver(base, '/iso', (ws, root) => { clones.push([ws, root]); return `/iso/${ws.id}`; }, { preferIsolated: true });
    expect(r.resolve({ id: 'ws-9', name: 'local', repo: 'https://github.com/example/local' })).toBe('/iso/ws-9');
    expect(clones).toHaveLength(1);
  });

  test('preferIsolated: a failed isolated clone still falls back to the base resolver', () => {
    const r = createOnceResolver(base, '/iso', () => { throw new Error('clone failed'); }, { preferIsolated: true });
    expect(r.resolve({ id: 'ws-9', name: 'local', repo: 'https://github.com/example/local' })).toBe('/repos/local');
  });

  test('preferIsolated: a clone GitHub throttled does not fall back to a second clone through the base resolver', () => {
    let baseCalls = 0;
    const counting = { ...base, resolve: (ws: any) => { baseCalls++; return base.resolve(ws); } };
    const r = createOnceResolver(counting, '/iso', () => { throw new GitCloneError('git clone was rate limited by GitHub: 429', true); }, { preferIsolated: true });
    expect(r.resolve({ id: 'ws-9', name: 'remote', repo: 'https://github.com/example/remote' })).toBeNull();
    expect(baseCalls).toBe(0);
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
