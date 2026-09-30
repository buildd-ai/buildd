/**
 * TaskSupervisor against a fake container: no Workers runtime, no Docker.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { INITIAL_STATE, type RunState } from './lifecycle';
import { TaskSupervisor, type ContainerPort, type ProcessPort, type SupervisorDeps } from './supervisor';

const TASK_ID = 'task-abc123';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`${l}\n`));
      c.close();
    },
  });
}

/** One process per exec; each run's exit is resolved by the test. */
function fakeContainer() {
  const calls: string[] = [];
  const starts: Array<{ env: Record<string, string>; enableInternet: boolean }> = [];
  const execs: string[][] = [];
  const exits: Array<ReturnType<typeof deferred<number>>> = [];
  let died = deferred<void>();
  let stdout: string[] = [];
  let inactivityMs: number | null = null;
  let running = false;
  const container: ContainerPort = {
    get running() { return running; },
    start(opts) { calls.push('start'); starts.push(opts); running = true; died = deferred<void>(); },
    async exec(cmd) {
      calls.push('exec');
      execs.push(cmd);
      const exit = deferred<number>();
      exits.push(exit);
      const proc: ProcessPort = { stdout: streamOf(stdout), stderr: streamOf([]), exitCode: exit.promise };
      return proc;
    },
    monitor() { return died.promise; },
    async destroy() { calls.push('destroy'); running = false; died.resolve(); },
    async setInactivityTimeout(ms) { inactivityMs = ms; },
  };
  return {
    container, calls, starts, execs, exits,
    setStdout(lines: string[]) { stdout = lines; },
    kill() { running = false; died.resolve(); },
    get inactivityMs() { return inactivityMs; },
  };
}

function harness(opts: { config?: Partial<SupervisorDeps['config']>; fetchStatus?: number; fetchThrows?: boolean; initial?: RunState } = {}) {
  let state: RunState = opts.initial ?? INITIAL_STATE;
  const fc = fakeContainer();
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const logs: string[] = [];
  let keepAliveHeld = 0;
  const pending: Promise<unknown>[] = [];
  const deps: SupervisorDeps = {
    taskId: TASK_ID,
    getState: () => state,
    setState: (s) => { state = s; },
    container: fc.container,
    config: {
      BUILDD_SERVER: 'http://127.0.0.1:9',
      BUILDD_API_KEY: 'bld_test_key',
      inactivityTimeoutMs: 1_800_000,
      startTimeoutMs: 1_000,
      ...opts.config,
    },
    keepAliveWhile: async (fn) => { keepAliveHeld++; try { return await fn(); } finally { keepAliveHeld--; } },
    waitUntil: (p) => { pending.push(p); },
    installEgress: async () => { fc.calls.push('installEgress'); },
    fetch: (async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      if (opts.fetchThrows) throw new Error('network down');
      return new Response('{}', { status: opts.fetchStatus ?? 200 });
    }) as unknown as typeof fetch,
    now: () => Date.now(),
    sleep: () => new Promise(r => setTimeout(r, 1)),
    log: (m) => logs.push(m),
  };
  const sup = new TaskSupervisor(deps);
  return {
    sup, fc, fetches, logs,
    get state() { return state; },
    get keepAliveHeld() { return keepAliveHeld; },
    /** Wait for the run started by the last dispatch to settle. */
    async settle() { await Promise.all(pending); },
    /** Let microtasks/short sleeps run until `pred` holds. */
    async until(pred: () => boolean) {
      for (let i = 0; i < 500 && !pred(); i++) await new Promise(r => setTimeout(r, 1));
      if (!pred()) throw new Error('condition never held');
    },
  };
}

describe('dispatch', () => {
  test('starts a container, execs buildd-once for the task, holds keepAlive while it runs', async () => {
    const h = harness();
    expect(h.sup.dispatch()).toEqual({ accepted: true, attempt: 1 });
    expect(h.state.status).toBe('starting');
    await h.until(() => h.state.status === 'running');
    expect(h.fc.execs).toEqual([['buildd-once', '--task', TASK_ID]]);
    expect(h.fc.starts[0]!.env.BUILDD_SERVER).toBe('http://127.0.0.1:9');
    expect(h.fc.starts[0]!.env.ANTHROPIC_API_KEY).toBeTruthy();
    expect(h.fc.starts[0]!.enableInternet).toBe(true);
    expect(h.fc.inactivityMs).toBe(1_800_000);
    expect(h.fc.calls.indexOf('installEgress')).toBeLessThan(h.fc.calls.indexOf('start'));
    expect(h.keepAliveHeld).toBe(1);

    h.fc.exits[0]!.resolve(0);
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', exitCode: 0, outcome: 'done', attempt: 1 });
    expect(h.state.endedAt).toBeGreaterThanOrEqual(h.state.startedAt!);
    expect(h.keepAliveHeld).toBe(0);
    expect(h.fc.calls.at(-1)).toBe('destroy');
    expect(h.fc.container.running).toBe(false);
    expect(h.fetches).toHaveLength(0); // the runner reported; the agent does not
  });

  test('a duplicate dispatch while starting or running is a no-op', async () => {
    const h = harness();
    h.sup.dispatch();
    expect(h.sup.dispatch()).toEqual({ accepted: false, reason: 'already_live', attempt: 1, status: 'starting' });
    await h.until(() => h.state.status === 'running');
    expect(h.sup.dispatch()).toEqual({ accepted: false, reason: 'already_live', attempt: 1, status: 'running' });
    expect(h.fc.starts).toHaveLength(1);
    expect(h.fc.execs).toHaveLength(1);
    h.fc.exits[0]!.resolve(1);
    await h.settle();
    expect(h.fc.starts).toHaveLength(1);
  });

  test('a dispatch after exit starts attempt 2 in a fresh container', async () => {
    const h = harness();
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(1);
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'failed', attempt: 1 });

    expect(h.sup.dispatch()).toEqual({ accepted: true, attempt: 2 });
    await h.until(() => h.state.status === 'running');
    expect(h.state.outcome).toBeUndefined(); // previous attempt's result cleared
    expect(h.fc.starts).toHaveLength(2);
    h.fc.exits[1]!.resolve(0);
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'done', attempt: 2 });
  });

  test('a dispatch during post-exit cleanup is ignored, not started on top of it', async () => {
    const h = harness();
    h.fc.setStdout(['BUILDD_WORKER_ID=w-1']);
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running' && h.state.workerId === 'w-1');
    h.fc.exits[0]!.resolve(137);
    // Crash report in flight: still live.
    expect(h.sup.dispatch().accepted).toBe(false);
    await h.settle();
    expect(h.state.status).toBe('exited');
    expect(h.fc.starts).toHaveLength(1);
  });

  test.each([
    [0, 'done'], [1, 'failed'], [3, 'refused'], [64, 'usage'], [137, 'crashed'], [2, 'crashed'],
  ] as const)('exit %p is recorded as %p', async (code, outcome) => {
    const h = harness();
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(code);
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', exitCode: code, outcome });
  });
});

describe('crash handling', () => {
  test('a crash after the worker id was printed marks the worker failed in buildd', async () => {
    const h = harness();
    h.fc.setStdout(['[once] starting', 'BUILDD_WORKER_ID=worker-42', '[once] worker worker-42 started']);
    h.sup.dispatch();
    await h.until(() => h.state.workerId === 'worker-42');
    h.fc.exits[0]!.resolve(137);
    await h.settle();
    expect(h.state).toMatchObject({ outcome: 'crashed', exitCode: 137, workerId: 'worker-42', crashReport: 'sent' });
    expect(h.fetches).toHaveLength(1);
    const { url, init } = h.fetches[0]!;
    expect(url).toBe('http://127.0.0.1:9/api/workers/worker-42');
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bld_test_key');
    const body = JSON.parse(init.body as string);
    expect(body.status).toBe('failed');
    expect(body.error).toContain('137');
    expect(h.state.outputTail).toContain('BUILDD_WORKER_ID=worker-42');
  });

  test('the container dying under the process is a crash', async () => {
    const h = harness();
    h.fc.setStdout(['BUILDD_WORKER_ID=worker-7']);
    h.sup.dispatch();
    await h.until(() => h.state.workerId === 'worker-7');
    h.fc.kill();
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', exitCode: null, outcome: 'crashed', crashReport: 'sent' });
    expect(h.state.error).toMatch(/container stopped/);
  });

  test('a crash before any worker id is not reported (nothing to mark)', async () => {
    const h = harness();
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(139);
    await h.settle();
    expect(h.state).toMatchObject({ outcome: 'crashed', crashReport: 'no_worker_id' });
    expect(h.fetches).toHaveLength(0);
  });

  test('a rejected or failing crash report is recorded, not retried', async () => {
    for (const [o, want] of [[{ fetchStatus: 409 }, 'rejected'], [{ fetchThrows: true }, 'error']] as const) {
      const h = harness(o);
      h.fc.setStdout(['BUILDD_WORKER_ID=w-9']);
      h.sup.dispatch();
      await h.until(() => h.state.workerId === 'w-9');
      h.fc.exits[0]!.resolve(137);
      await h.settle();
      expect(h.state.crashReport).toBe(want);
      expect(h.fetches).toHaveLength(1);
    }
  });

  test('a container that never starts ends the run as crashed without an exec', async () => {
    const h = harness({ config: { startTimeoutMs: 20 } });
    const realStart = h.fc.container.start.bind(h.fc.container);
    (h.fc.container as { start: ContainerPort['start'] }).start = (o) => { realStart(o); h.fc.kill(); };
    h.sup.dispatch();
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'crashed' });
    expect(h.state.error).toMatch(/did not start/);
    expect(h.fc.execs).toHaveLength(0);
  });

  test('missing server config is a usage outcome and starts no container', async () => {
    const h = harness({ config: { BUILDD_SERVER: undefined } });
    h.sup.dispatch();
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'usage' });
    expect(h.fc.starts).toHaveLength(0);
  });
});

describe('orphan recovery', () => {
  test('a run marked live in storage with nothing in memory is marked crashed and reported', async () => {
    const h = harness({ initial: { taskId: TASK_ID, attempt: 3, status: 'running', workerId: 'w-orphan', startedAt: 1 } });
    await h.sup.recoverOrphan();
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'crashed', attempt: 3, crashReport: 'sent' });
    expect(h.fetches[0]!.url).toContain('/api/workers/w-orphan');
    expect(h.fc.starts).toHaveLength(0); // recovery never starts a run
  });

  test('an exited or idle agent is left alone', async () => {
    for (const initial of [INITIAL_STATE, { ...INITIAL_STATE, status: 'exited' as const, attempt: 1, outcome: 'done' as const }]) {
      const h = harness({ initial });
      await h.sup.recoverOrphan();
      expect(h.state).toEqual(initial);
      expect(h.fetches).toHaveLength(0);
    }
  });
});

describe('never re-dispatches on its own', () => {
  test('after any outcome, no further container starts happen without a new dispatch', async () => {
    for (const code of [0, 1, 3, 64, 137]) {
      const h = harness();
      h.sup.dispatch();
      await h.until(() => h.state.status === 'running');
      h.fc.exits[0]!.resolve(code);
      await h.settle();
      await new Promise(r => setTimeout(r, 30));
      expect(h.fc.starts).toHaveLength(1);
      expect(h.fc.execs).toHaveLength(1);
    }
  });

  test('the agent code has no timer or alarm that could poll or re-dispatch', () => {
    for (const file of ['supervisor.ts', 'worker-agent.ts', 'index.ts', 'http.ts', 'lifecycle.ts']) {
      const src = readFileSync(join(import.meta.dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/setInterval|setAlarm|\.schedule\(|scheduleEvery|cron/);
    }
  });
});
