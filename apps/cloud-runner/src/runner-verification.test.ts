import { describe, expect, test } from 'bun:test';
import {
  checkoutPath,
  parseVerificationRunResponse,
  runRunnerVerification,
  verificationExecCommand,
  verificationRunRequest,
  type VerificationDeps,
} from './runner-verification';
import type { ProcessPort } from './supervisor';

const TASK = 'task-1';
const WORKER = 'worker-1';
const CFG = { BUILDD_SERVER: 'https://buildd.example/', BUILDD_API_KEY: 'bld_runner_key', DISPATCH_TOKEN: 'dispatch-1' };
const PLAN = { taskId: TASK, workerId: WORKER, workspaceId: 'ws-1', run: true, command: 'bun run test', iteration: 0 };

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { if (text) c.enqueue(new TextEncoder().encode(text)); c.close(); } });
}

/** A container whose exec'd processes exit with the given codes, in order. */
function harness(opts: {
  exits?: Array<number | 'hang' | 'throw'>;
  stdout?: string;
  plan?: unknown;
  planStatus?: number;
  reportStatus?: number;
} = {}) {
  const exits = [...(opts.exits ?? [0, 0])];
  const execs: Array<{ cmd: string[]; env?: Record<string, string> }> = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const logs: string[] = [];
  let fire: (() => void) | undefined;
  const deps: VerificationDeps = {
    container: {
      async exec(cmd, o) {
        execs.push({ cmd, env: o?.env });
        const e = exits.shift() ?? 0;
        if (e === 'throw') throw new Error('exec refused');
        const proc: ProcessPort = {
          stdout: streamOf(opts.stdout ?? ''),
          stderr: streamOf(''),
          exitCode: e === 'hang' ? new Promise<number>(() => {}) : Promise.resolve(e),
        };
        return proc;
      },
    },
    fetch: (async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      if (url.endsWith('/api/runner/verification-run')) {
        return new Response(JSON.stringify(opts.plan ?? PLAN), { status: opts.planStatus ?? 200 });
      }
      return new Response('{}', { status: opts.reportStatus ?? 409 });
    }) as unknown as typeof fetch,
    log: (m) => logs.push(m),
    now: () => 1_000,
    timeout: () => ({ promise: new Promise<void>(r => { fire = r; }), cancel: () => {} }),
  };
  return {
    deps, execs, fetches, logs,
    fireTimeout: () => fire?.(),
    reported: () => {
      const patch = fetches.find(f => f.init.method === 'PATCH');
      return patch ? JSON.parse(patch.init.body as string) : undefined;
    },
  };
}

describe('the request for a plan', () => {
  test('runner key and dispatch token, task and worker in the body', () => {
    const { url, init } = verificationRunRequest(CFG, TASK, WORKER);
    expect(url).toBe('https://buildd.example/api/runner/verification-run');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bld_runner_key');
    expect((init.headers as Record<string, string>)['X-Buildd-Dispatch-Token']).toBe('dispatch-1');
    expect(JSON.parse(init.body as string)).toEqual({ taskId: TASK, workerId: WORKER });
  });

  test('an answer for another task or worker, or without a run, is no plan', () => {
    expect(parseVerificationRunResponse(PLAN, TASK, WORKER)).toEqual({ command: 'bun run test', iteration: 0, workspaceId: 'ws-1' });
    expect(parseVerificationRunResponse({ ...PLAN, taskId: 'other' }, TASK, WORKER)).toBeNull();
    expect(parseVerificationRunResponse({ ...PLAN, workerId: 'other' }, TASK, WORKER)).toBeNull();
    expect(parseVerificationRunResponse({ ...PLAN, run: false }, TASK, WORKER)).toBeNull();
    expect(parseVerificationRunResponse({ ...PLAN, workspaceId: '../etc' }, TASK, WORKER)).toBeNull();
    expect(parseVerificationRunResponse({ ...PLAN, command: ' ' }, TASK, WORKER)).toBeNull();
  });
});

describe('where and how the command runs', () => {
  test("the checkout is the runner's isolated clone, from buildd's workspace id", () => {
    expect(checkoutPath('ws-1')).toBe('/home/bun/.buildd/once-workspaces/ws-1');
    expect(checkoutPath('a/b c')).toBe('/home/bun/.buildd/once-workspaces/a_b_c');
  });

  test('path and command travel as arguments, not spliced into the shell text', () => {
    const cmd = verificationExecCommand('/x', 'echo "$HOME"; false');
    expect(cmd.slice(0, 3)).toEqual(['sh', '-c', 'cd -- "$1" && exec sh -c "$2"']);
    expect(cmd.slice(4)).toEqual(['/x', 'echo "$HOME"; false']);
  });
});

describe('runRunnerVerification', () => {
  test('a pass: runs in the checkout, reports exit 0 on the runner key', async () => {
    const h = harness({ exits: [0, 0], stdout: 'all good\n' });
    expect(await runRunnerVerification(h.deps, CFG, TASK, WORKER)).toBe('reported');
    expect(h.execs[0]!.cmd).toEqual(['test', '-d', '/home/bun/.buildd/once-workspaces/ws-1']);
    expect(h.execs[1]!.cmd).toEqual(verificationExecCommand('/home/bun/.buildd/once-workspaces/ws-1', 'bun run test'));
    const patch = h.fetches.find(f => f.init.method === 'PATCH')!;
    expect(patch.url).toBe('https://buildd.example/api/workers/worker-1');
    expect((patch.init.headers as Record<string, string>).Authorization).toBe('Bearer bld_runner_key');
    expect(h.reported()).toEqual({
      verificationEvidence: { workerId: WORKER, iteration: 0, conditionType: 'command', command: 'bun run test', exitCode: 0, durationMs: 0, stdout: 'all good\n', stderr: '', outcome: 'ok' },
    });
  });

  test('security: the command runs without any buildd credential in its env', async () => {
    const h = harness();
    await runRunnerVerification(h.deps, CFG, TASK, WORKER);
    for (const e of h.execs) {
      const values = Object.values(e.env ?? {}).join('\n');
      expect(values).not.toContain('bld_runner_key');
      expect(values).not.toContain('dispatch-1');
      expect(e.env?.BUILDD_API_KEY).toBeUndefined();
    }
  });

  test('a non-zero exit is a failed check', async () => {
    const h = harness({ exits: [0, 3] });
    await runRunnerVerification(h.deps, CFG, TASK, WORKER);
    expect(h.reported().verificationEvidence).toMatchObject({ exitCode: 3, outcome: 'failed' });
  });

  test('a command that outlives the timeout is reported as a timeout, no exit code', async () => {
    const h = harness({ exits: [0, 'hang'] });
    const run = runRunnerVerification(h.deps, CFG, TASK, WORKER);
    await new Promise(r => setTimeout(r, 5));
    h.fireTimeout();
    expect(await run).toBe('reported');
    expect(h.reported().verificationEvidence).toMatchObject({ outcome: 'timeout' });
    expect(h.reported().verificationEvidence.exitCode).toBeUndefined();
  });

  test('an exec the platform refuses is an exec_error', async () => {
    const h = harness({ exits: [0, 'throw'] });
    await runRunnerVerification(h.deps, CFG, TASK, WORKER);
    expect(h.reported().verificationEvidence).toMatchObject({ outcome: 'exec_error' });
  });

  test('stdout is capped at the excerpt size', async () => {
    const h = harness({ stdout: 'x'.repeat(10_000) });
    await runRunnerVerification(h.deps, CFG, TASK, WORKER);
    expect(h.reported().verificationEvidence.stdout).toHaveLength(4096);
  });

  test('no checkout in the container: nothing runs, nothing is reported', async () => {
    const h = harness({ exits: [1] });
    expect(await runRunnerVerification(h.deps, CFG, TASK, WORKER)).toBe('no_checkout');
    expect(h.execs).toHaveLength(1);
    expect(h.reported()).toBeUndefined();
  });

  test('not a verification run, or an older buildd: nothing runs', async () => {
    for (const o of [{ plan: { taskId: TASK, workerId: WORKER, run: false, reason: 'not_a_verification_run' } }, { planStatus: 404 }]) {
      const h = harness(o);
      expect(await runRunnerVerification(h.deps, CFG, TASK, WORKER)).toBe('not_needed');
      expect(h.execs).toHaveLength(0);
      expect(h.reported()).toBeUndefined();
    }
  });

  test('no dispatch token in this Worker: skipped without a request', async () => {
    const h = harness();
    expect(await runRunnerVerification(h.deps, { ...CFG, DISPATCH_TOKEN: undefined }, TASK, WORKER)).toBe('skipped');
    expect(h.fetches).toHaveLength(0);
  });

  test('a refused report is an error, and never throws', async () => {
    const h = harness({ reportStatus: 403 });
    expect(await runRunnerVerification(h.deps, CFG, TASK, WORKER)).toBe('error');
    const t = harness();
    t.deps.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await runRunnerVerification(t.deps, CFG, TASK, WORKER)).toBe('error');
  });
});

describe('a mission criterion batch (one run per target, R-81)', () => {
  const SHA = 'a'.repeat(40);
  const BATCH_PLAN = {
    taskId: TASK, workerId: WORKER, workspaceId: 'ws-1', run: true, iteration: 0, kind: 'criterion_batch', headSha: SHA,
    checks: [{ criterionId: 'AC-1', command: 'bun run a', timeoutMs: 180_000 }, { criterionId: 'AC-2', command: 'bun run b', timeoutMs: 600_000 }],
  };

  test('the plan carries every criterion and its own timeout', () => {
    expect(parseVerificationRunResponse(BATCH_PLAN, TASK, WORKER)).toMatchObject({ workspaceId: 'ws-1', batch: { headSha: SHA, checks: BATCH_PLAN.checks } });
    expect(parseVerificationRunResponse({ ...BATCH_PLAN, headSha: 'abc' }, TASK, WORKER)).toBeNull();
    expect(parseVerificationRunResponse({ ...BATCH_PLAN, checks: [] }, TASK, WORKER)).toBeNull();
  });

  test('checks out once, runs each criterion under its own limit, and reports one result per criterion on the runner key', async () => {
    const timeouts: number[] = [];
    // probe, checkout, probe, AC-1, probe, AC-2
    const h = harness({ plan: BATCH_PLAN, exits: [0, 0, 0, 0, 0, 1], stdout: ' 3 pass\n' });
    const inner = h.deps.timeout!;
    h.deps.timeout = (ms) => { timeouts.push(ms); return inner(ms); };
    expect(await runRunnerVerification(h.deps, CFG, TASK, WORKER)).toBe('reported');
    const commands = h.execs.filter((e) => e.cmd[0] === 'sh').map((e) => e.cmd[5]);
    expect(commands[0]).toContain(`git checkout -q --detach ${SHA}`);
    expect(commands.slice(1)).toEqual(['bun run a', 'bun run b']);
    expect(timeouts.slice(1)).toEqual([180_000, 600_000]);
    const ev = h.reported().verificationEvidence;
    expect(ev).toMatchObject({ conditionType: 'criterion_batch', workerId: WORKER, headSha: SHA, checkout: 'ok' });
    expect(ev.results).toEqual([
      expect.objectContaining({ criterionId: 'AC-1', command: 'bun run a', outcome: 'ok', exitCode: 0, timeoutMs: 180_000, stdout: ' 3 pass\n' }),
      expect.objectContaining({ criterionId: 'AC-2', command: 'bun run b', outcome: 'failed', exitCode: 1, timeoutMs: 600_000 }),
    ]);
  });

  test('a head that cannot be checked out runs no criterion and reports each as a failed checkout', async () => {
    const h = harness({ plan: BATCH_PLAN, exits: [0, 128] });
    expect(await runRunnerVerification(h.deps, CFG, TASK, WORKER)).toBe('reported');
    expect(h.execs.filter((e) => e.cmd[0] === 'sh')).toHaveLength(1);
    const ev = h.reported().verificationEvidence;
    expect(ev.checkout).toBe('failed');
    expect(ev.results.map((r: any) => [r.criterionId, r.exitCode])).toEqual([['AC-1', 125], ['AC-2', 125]]);
  });
});
