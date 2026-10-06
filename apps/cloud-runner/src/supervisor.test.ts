/**
 * TaskSupervisor against a fake container: no Workers runtime, no Docker.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { INITIAL_STATE, MAX_DEFERRED_RETRIES, buildContainerEnv, type RunState } from './lifecycle';
import { TaskSupervisor, type ContainerPort, type ProcessPort, type ScheduledDispatchPayload, type SchedulerPort, type SupervisorDeps } from './supervisor';

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
  const execEnvs: Array<Record<string, string> | undefined> = [];
  const exits: Array<ReturnType<typeof deferred<number>>> = [];
  let died = deferred<void>();
  let stdout: string[] = [];
  let inactivityMs: number | null = null;
  let running = false;
  const container: ContainerPort = {
    get running() { return running; },
    start(opts) { calls.push('start'); starts.push(opts); running = true; died = deferred<void>(); },
    async exec(cmd, opts) {
      calls.push('exec');
      execs.push(cmd);
      execEnvs.push(opts?.env);
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
    container, calls, starts, execs, execEnvs, exits,
    setStdout(lines: string[]) { stdout = lines; },
    kill() { running = false; died.resolve(); },
    /** A container left running from before an agent restart. */
    markRunning() { running = true; died = deferred<void>(); },
    get inactivityMs() { return inactivityMs; },
  };
}

/** The Agents SDK schedule API, faked: records one-shots and fires them on demand. */
function fakeScheduler() {
  let seq = 0;
  const scheduled = new Map<string, { at: number; payload: ScheduledDispatchPayload }>();
  const cancelled: string[] = [];
  const port: SchedulerPort = {
    async scheduleAt(at, payload) {
      const id = `sched-${++seq}`;
      scheduled.set(id, { at, payload });
      return id;
    },
    async cancel(id) { cancelled.push(id); scheduled.delete(id); },
  };
  return { port, scheduled, cancelled };
}

function harness(opts: { config?: Partial<SupervisorDeps['config']>; fetchStatus?: number; fetchThrows?: boolean; initial?: RunState; egressFails?: boolean; mintFails?: boolean; fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number } = {}) {
  let state: RunState = opts.initial ?? INITIAL_STATE;
  const sched = fakeScheduler();
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
    installEgress: async () => {
      fc.calls.push('installEgress');
      if (opts.egressFails) throw new Error('interceptOutboundHttps failed');
    },
    mintTaskToken: async () => {
      fc.calls.push('mintTaskToken');
      if (opts.mintFails) throw new Error('POST /api/runner/task-token returned 503');
      return 'bldt_test_task_token';
    },
    fetch: (async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      if (opts.fetchImpl) return opts.fetchImpl(url, init);
      if (opts.fetchThrows) throw new Error('network down');
      return new Response('{}', { status: opts.fetchStatus ?? 200 });
    }) as unknown as typeof fetch,
    scheduler: sched.port,
    now: opts.now ?? (() => Date.now()),
    sleep: () => new Promise(r => setTimeout(r, 1)),
    log: (m) => logs.push(m),
  };
  const sup = new TaskSupervisor(deps);
  return {
    sup, fc, fetches, logs, sched,
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
  test('egress that cannot be installed means the container never starts (fail closed)', async () => {
    const h = harness({ egressFails: true });
    h.sup.dispatch();
    await h.settle();
    expect(h.fc.calls).not.toContain('start');
    expect(h.fc.execs).toEqual([]);
    expect(h.state.status).toBe('exited');
    expect(h.state.error).toContain('interceptOutboundHttps failed');
  });

  test('the started container gets the cloud executor marker and no GitHub token', async () => {
    const h = harness();
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    const env = h.fc.starts[0]!.env;
    expect(env.BUILDD_EXECUTOR).toBe('cloud');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test('security: the container holds the per-task token, never the runner key', async () => {
    const h = harness();
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    const env = h.fc.starts[0]!.env;
    expect(env.BUILDD_API_KEY).toBe('bldt_test_task_token');
    expect(Object.values(env).join('\n')).not.toContain('bld_test_key');
  });

  test('the runner process gets the run env itself: exec does not inherit start() env on Cloudflare', async () => {
    // Docker's exec inherits the container env, so a local run passed with
    // the env on start() alone; a real Cloudflare container started the
    // runner with no BUILDD_API_KEY and it exited 64.
    const h = harness();
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    const env = h.fc.execEnvs[0];
    expect(env).toEqual(h.fc.starts[0]!.env);
    expect(env!.BUILDD_API_KEY).toBe('bldt_test_task_token');
    expect(env!.BUILDD_EXECUTOR).toBe('cloud');
  });

  test('a failed mint starts no container', async () => {
    const h = harness({ mintFails: true });
    h.sup.dispatch();
    await h.settle();
    expect(h.fc.starts).toHaveLength(0);
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'crashed' });
    expect(h.state.error).toContain('task-token');
  });

  test('telemetry: no OTLP endpoint means the container env is exactly buildContainerEnv (pinned)', async () => {
    const h = harness({ config: { OTEL_LOG_TOOL_DETAILS: '1', OTEL_TRACES_BETA: '1', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' } });
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    expect(h.fc.starts[0]!.env).toEqual(buildContainerEnv({ BUILDD_SERVER: 'http://127.0.0.1:9' }, 'bldt_test_task_token'));
  });

  test('telemetry: an OTLP endpoint adds the Claude Code vars with this dispatch\'s task and attempt, never auth', async () => {
    const h = harness({
      config: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com' },
      initial: { ...INITIAL_STATE, taskId: TASK_ID, attempt: 2, status: 'exited' },
    });
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    const env = h.fc.starts[0]!.env;
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://otel.example.com');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(`buildd.task_id=${TASK_ID},buildd.attempt=3`);
    expect(Object.keys(env).filter(k => k.includes('AUTH') || k.endsWith('_HEADERS'))).toEqual([]);
  });

  test('telemetry: an invalid OTLP endpoint fails the run before start', async () => {
    const h = harness({ config: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example.com' } });
    h.sup.dispatch();
    await h.settle();
    expect(h.fc.calls).not.toContain('start');
    expect(h.state.status).toBe('exited');
    expect(h.state.error).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
  });

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
    const patches = h.fetches.filter(f => f.init.method === 'PATCH');
    expect(patches).toHaveLength(1);
    const { url, init } = patches[0]!;
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

  // A container that died under the runner is infrastructure, not the
  // agent's verdict on the work. The report carries the same structured flag
  // the runner's own boot reconciliation sends for a session its process lost
  // (`crashReconciled`), so buildd puts the task on its infra-retry budget
  // (backoff, infraRetryCount, infra_stalled at the cap) instead of failing it.
  test.each([
    ['signal-killed runner', (h: ReturnType<typeof harness>) => h.fc.exits[0]!.resolve(137)],
    ['container stopped under the process', (h: ReturnType<typeof harness>) => h.fc.kill()],
  ] as const)('a crash report for a %s is flagged as an infrastructure crash', async (_name, crash) => {
    const h = harness();
    h.fc.setStdout(['BUILDD_WORKER_ID=worker-infra']);
    h.sup.dispatch();
    await h.until(() => h.state.workerId === 'worker-infra');
    crash(h);
    await h.settle();
    const patches = h.fetches.filter(f => f.init.method === 'PATCH');
    expect(patches).toHaveLength(1);
    const body = JSON.parse(patches[0]!.init.body as string);
    expect(body).toMatchObject({ status: 'failed', crashReconciled: true });
  });

  test.each([
    [0, 'done'], [1, 'failed'], [3, 'refused'], [64, 'usage'], [4, 'parked'],
  ] as const)('exit %p (%p) sends no crash report, so nothing is flagged infra', async (code) => {
    const h = harness();
    h.fc.setStdout(['BUILDD_WORKER_ID=worker-own']);
    h.sup.dispatch();
    await h.until(() => h.state.workerId === 'worker-own');
    h.fc.exits[0]!.resolve(code);
    await h.settle();
    const patches = h.fetches.filter(f => f.init.method === 'PATCH');
    expect(patches).toHaveLength(0);
    expect(h.fetches.some(f => typeof f.init.body === 'string' && f.init.body.includes('crashReconciled'))).toBe(false);
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
      expect(h.fetches.filter(f => f.init.method === 'PATCH')).toHaveLength(1);
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

describe('deferred claims and container-capacity starts self-schedule a retry', () => {
  const NOW = 2_000_000;

  test('a claim deferred for capacity (exit 5) is `deferred`, not crashed; no crash report; a backoff retry is scheduled', async () => {
    const h = harness({ now: () => NOW });
    h.fc.setStdout(['[once] claim deferred: no_pending_tasks', 'BUILDD_CLAIM_DEFERRED=workspace_cap']);
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(5);
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', exitCode: 5, outcome: 'deferred', claimDeferredReason: 'workspace_cap', deferredRetryCount: 1 });
    // Pre-claim: no worker was ever created, so there is nothing to crash-report.
    expect(h.fetches).toHaveLength(0);
    expect(h.state.report).toMatchObject({ outcome: 'deferred', crashReport: null, deferredRetry: { retryNumber: 1, backoffMs: 30_000, reason: 'workspace_cap' } });
    expect([...h.sched.scheduled.values()]).toEqual([{ at: NOW + 30_000, payload: { notBefore: NOW + 30_000, deferredRetry: true } }]);
  });

  test('a container-capacity start failure is `start_deferred`, not crashed, with no exec attempted; a backoff retry is scheduled', async () => {
    const h = harness({ now: () => NOW });
    (h.fc.container as { start: ContainerPort['start'] }).start = () => {
      throw new Error('There is no container instance that can be provided to this Durable Object, try again later.');
    };
    h.sup.dispatch();
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', exitCode: null, outcome: 'start_deferred', deferredRetryCount: 1 });
    expect(h.fc.execs).toHaveLength(0); // never got past starting the container
    expect(h.fetches).toHaveLength(0); // pre-claim: nothing to crash-report
    expect(h.state.report).toMatchObject({ outcome: 'start_deferred', crashReport: null, deferredRetry: { retryNumber: 1, backoffMs: 30_000, reason: 'container_capacity' } });
    expect([...h.sched.scheduled.values()]).toEqual([{ at: NOW + 30_000, payload: { notBefore: NOW + 30_000, deferredRetry: true } }]);
  });

  test('a container start failure for an unrelated reason stays a crash (not deferred)', async () => {
    const h = harness({ now: () => NOW });
    (h.fc.container as { start: ContainerPort['start'] }).start = () => { throw new Error('image pull failed: unauthorized'); };
    h.sup.dispatch();
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'crashed' });
    expect(h.state.deferredRetryCount).toBeUndefined();
    expect(h.sched.scheduled.size).toBe(0);
  });

  test('backoff increases per consecutive deferred attempt and stops at the cap, leaving the task alone', async () => {
    const c = { t: NOW };
    const h = harness({ now: () => c.t });
    h.fc.setStdout(['BUILDD_CLAIM_DEFERRED=no_slots']);
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(5);
    await h.settle();

    const backoffs: number[] = [];
    for (let retryNumber = 1; retryNumber <= MAX_DEFERRED_RETRIES; retryNumber++) {
      expect(h.state.deferredRetryCount).toBe(retryNumber);
      const ids = [...h.sched.scheduled.keys()];
      const scheduleId = ids[ids.length - 1]!;
      const entry = h.sched.scheduled.get(scheduleId)!;
      expect(entry.payload.deferredRetry).toBe(true);
      backoffs.push(entry.at - c.t);
      c.t = entry.at;
      h.fc.setStdout(['BUILDD_CLAIM_DEFERRED=no_slots']);
      expect(h.sup.fireScheduledDispatch(entry.payload, scheduleId)).toMatchObject({ fired: true, accepted: true });
      await h.until(() => h.state.status === 'running');
      h.fc.exits[h.fc.exits.length - 1]!.resolve(5);
      await h.settle();
    }
    // Every retry's backoff is at least as long as the one before it.
    for (let i = 1; i < backoffs.length; i++) expect(backoffs[i]).toBeGreaterThan(backoffs[i - 1]!);
    // One more consecutive deferral past the cap: gives up, nothing new scheduled.
    expect(h.state.deferredRetryCount).toBe(MAX_DEFERRED_RETRIES + 1);
    expect(h.sched.scheduled.size).toBe(MAX_DEFERRED_RETRIES);
  });
});

describe('orphan recovery', () => {
  test('a run marked live in storage with nothing in memory is marked crashed and reported', async () => {
    const h = harness({ initial: { taskId: TASK_ID, attempt: 3, status: 'running', workerId: 'w-orphan', startedAt: 1 } });
    await h.sup.recoverOrphan();
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'crashed', attempt: 3, crashReport: 'sent' });
    expect(h.fetches[0]!.url).toContain('/api/workers/w-orphan');
    expect(JSON.parse(h.fetches[0]!.init.body as string)).toMatchObject({ status: 'failed', crashReconciled: true });
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
      expect(src).not.toMatch(/setInterval|setAlarm|scheduleEvery|cron/);
      // The one alarm: the one-shot a `task.scheduled` dispatch asks for, at a
      // fixed Date, into the scheduled-dispatch callback. Never recurring.
      const schedules = src.match(/\.schedule\(/g) ?? [];
      if (file === 'worker-agent.ts') {
        expect(schedules).toHaveLength(1);
        expect(src).toMatch(/this\.schedule\(new Date\([^)]*\), 'runScheduledDispatch'/);
      } else {
        expect(schedules).toHaveLength(0);
      }
    }
  });
});

describe('run report', () => {
  const posts = (h: { fetches: Array<{ url: string; init: RequestInit }> }) =>
    h.fetches.filter(f => f.init.method === 'POST' && f.url.endsWith('/artifacts'));

  test('a claimed run records timings, runner phases, egress counters and delivers one artifact', async () => {
    const h = harness({ config: { instanceType: 'standard-1', containerInstanceId: 'do0123abcd' } });
    h.fc.setStdout([
      'BUILDD_WORKER_ID=worker-42',
      'BUILDD_PHASE=clone_start 1000',
      'BUILDD_PHASE=clone_end 3000',
      'BUILDD_PHASE=install_start 4000',
      'BUILDD_PHASE=install_end 9000',
    ]);
    h.sup.dispatch();
    await h.until(() => h.state.timings?.runnerPhases?.install_end !== undefined);
    expect(h.fc.starts[0]!.labels).toEqual({ bd_run: `${TASK_ID}.1` });
    h.sup.recordEgress({ type: 'request', cls: 'model', at: 123_456 });
    h.sup.recordEgress({ type: 'request', cls: 'model', at: 999_999 });
    h.sup.recordEgress({ type: 'bytes', cls: 'model', bytes: 2048 });
    h.sup.recordEgress({ type: 'request', cls: 'github', at: 1, rejected: true });
    h.sup.recordEgress({ type: 'request', cls: 'github', url: 'https://x' } as unknown); // not an event
    h.sup.recordEgress({ type: 'request', cls: 'github', at: 2, auth: 'grant_fetch_failed' });
    h.sup.recordEgress({ type: 'status', cls: 'github', status: 429, auth: 'grant_fetch_failed' });
    h.sup.recordEgress({ type: 'grant_failure', cls: 'github', status: 409 });
    h.fc.exits[0]!.resolve(0);
    await h.settle();

    const r = h.state.report!;
    expect(r).toMatchObject({
      taskId: TASK_ID, attempt: 1, workerId: 'worker-42', outcome: 'done', exitCode: 0,
      instanceType: 'standard-1', containerInstanceId: 'do0123abcd', runLabel: `${TASK_ID}.1`,
      runnerPhases: { clone_start: 1000, clone_end: 3000, install_start: 4000, install_end: 9000 },
      durationsMs: { clone: 2000, install: 5000 },
      delivery: 'sent',
    });
    expect(r.timestamps.dispatchReceivedAt).toBe(h.state.startedAt!);
    expect(r.timestamps.containerRunningAt).toBeGreaterThanOrEqual(r.timestamps.dispatchReceivedAt!);
    expect(r.timestamps.claimedAt).toBeGreaterThanOrEqual(r.timestamps.containerRunningAt!);
    expect(r.timestamps.firstModelRequestAt).toBe(123_456);
    expect(r.timestamps.exitedAt).toBeGreaterThanOrEqual(r.timestamps.claimedAt!);
    expect(r.egress.model).toEqual({ requests: 2, rejected: 0, responseBytes: 2048 });
    expect(r.egress.github).toEqual({ requests: 2, rejected: 1, responseBytes: 0 });
    // Unauthenticated GitHub forwards, their 429, and the agent's own token
    // fetch failure (not a request) all reach the report.
    expect(r.egressDetail.github).toMatchObject({
      credentialed: 0, unauthenticated: { grant_fetch_failed: 1 },
      unauthenticatedErrorStatuses: { '429': 1 }, grantFetchFailures: { '409': 1 },
    });

    const p = posts(h);
    expect(p).toHaveLength(1);
    expect(p[0]!.url).toBe('http://127.0.0.1:9/api/workers/worker-42/artifacts');
    expect((p[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer bld_test_key');
    const body = JSON.parse(p[0]!.init.body as string);
    expect(body.key).toBe('cloud-run-report:worker-42');
    expect(body.metadata.report.workerId).toBe('worker-42');
    // The stored copy carries the delivery; the delivered one does not.
    expect(body.metadata.report.delivery).toBeUndefined();
  });

  test('warm-repo lines land in the report: source, restore/fetch timings and bytes', async () => {
    const h = harness();
    h.fc.setStdout([
      'BUILDD_WORKER_ID=worker-7',
      'BUILDD_PHASE=restore_warm_start 1000',
      'BUILDD_METRIC=restore_bytes 5000',
      'BUILDD_PHASE=restore_warm_end 1400',
      'BUILDD_PHASE=fetch_start 1400',
      'BUILDD_PHASE=fetch_end 1500',
      'BUILDD_METRIC=fetch_bytes 64',
      'BUILDD_METRIC=snapshot_age_ms 7200000',
      'BUILDD_PHASE=restore_cache_start 1500',
      'BUILDD_PHASE=restore_cache_end 1750',
      'BUILDD_CACHE_SKIPPED=pnpm-store 2100000000 1073741824',
      'BUILDD_REPO_SOURCE=warm',
      'BUILDD_METRIC=bogus 1',
    ]);
    h.sup.dispatch();
    await h.until(() => h.state.timings?.repoSource !== undefined);
    h.fc.exits[0]!.resolve(0);
    await h.settle();
    const r = h.state.report!;
    expect(r.repo).toEqual({
      source: 'warm', fallbackReason: null, snapshotAgeMs: 7_200_000, warmUploadSkipReason: null,
      cacheSkipped: { part: 'pnpm-store', bytes: 2_100_000_000, cap: 1_073_741_824 },
      bytes: { clone: null, restore: 5000, fetch: 64, cache: null, cacheRaw: null, upload: null, warmRepo: null },
    });
    expect(r.durationsMs).toMatchObject({ restoreWarm: 400, fetch: 100, clone: null, restoreCache: 250 });
  });

  test('a warm upload skipped over the cap is reported with the measured size', async () => {
    const h = harness();
    h.fc.setStdout([
      'BUILDD_WORKER_ID=worker-9',
      'BUILDD_REPO_SOURCE=clone no_snapshot',
      'BUILDD_METRIC=warm_repo_bytes 2600000000',
      'BUILDD_WARM_UPLOAD=skipped too_large',
    ]);
    h.sup.dispatch();
    await h.until(() => h.state.timings?.warmUpload !== undefined);
    h.fc.exits[0]!.resolve(1);
    await h.settle();
    expect(h.state.report!.repo).toMatchObject({ source: 'clone', fallbackReason: 'no_snapshot', warmUploadSkipReason: 'too_large', bytes: { warmRepo: 2_600_000_000 } });
    expect(h.state.report!.durationsMs.warmUpload).toBeNull();
  });

  test('a clone fallback is reported with its reason', async () => {
    const h = harness();
    h.fc.setStdout(['BUILDD_WORKER_ID=worker-8', 'BUILDD_REPO_SOURCE=clone no_snapshot', 'BUILDD_METRIC=clone_bytes 9000']);
    h.sup.dispatch();
    await h.until(() => h.state.timings?.runnerMetrics?.clone_bytes !== undefined);
    h.fc.exits[0]!.resolve(1);
    await h.settle();
    expect(h.state.report!.repo).toMatchObject({ source: 'clone', fallbackReason: 'no_snapshot', bytes: { clone: 9000 } });
  });

  test('a run that never claimed stores its report and posts nothing', async () => {
    const h = harness();
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(1);
    await h.settle();
    expect(h.state.report).toMatchObject({ workerId: null, outcome: 'failed', delivery: 'no_worker_id' });
    expect(h.fetches).toHaveLength(0);
  });

  test('delivery never holds up the outcome, and a failed one is recorded, not retried beyond once', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const h = harness({
      fetchImpl: async (url) => {
        if (url.endsWith('/artifacts')) { await gate; throw new Error('network down'); }
        return new Response('{}');
      },
    });
    h.fc.setStdout(['BUILDD_WORKER_ID=w-1']);
    h.sup.dispatch();
    await h.until(() => h.state.workerId === 'w-1');
    h.fc.exits[0]!.resolve(0);
    await h.until(() => h.state.status === 'exited');
    expect(h.state.outcome).toBe('done');
    expect(h.state.report!.delivery).toBe('pending');
    release();
    await h.settle();
    expect(h.state.report!.delivery).toBe('error');
    expect(posts(h)).toHaveLength(2);
  });

  test('a dispatch during delivery starts attempt 2; the result lands on attempt 1 in the history', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const h = harness({
      fetchImpl: async (url) => {
        if (url.endsWith('/artifacts')) await gate;
        return new Response('{}');
      },
    });
    h.fc.setStdout(['BUILDD_WORKER_ID=w-1']);
    h.sup.dispatch();
    await h.until(() => h.state.workerId === 'w-1');
    h.fc.exits[0]!.resolve(0);
    await h.until(() => h.state.status === 'exited');
    expect(h.sup.dispatch()).toEqual({ accepted: true, attempt: 2 });
    expect(h.state.report).toBeUndefined();
    expect(h.state.reportHistory!.map(r => [r.attempt, r.delivery])).toEqual([[1, 'pending']]);
    release();
    await h.until(() => h.state.reportHistory![0]!.delivery === 'sent');
    await h.until(() => h.state.status === 'running');
    h.fc.exits[1]!.resolve(1);
    await h.settle();
    expect(h.state.report).toMatchObject({ attempt: 2, outcome: 'failed' });
    expect(h.state.reportHistory!.map(r => r.attempt)).toEqual([1]);
  });

  test('egress events outside a live run are ignored', async () => {
    const h = harness();
    h.sup.recordEgress({ type: 'request', cls: 'model', at: 5 });
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(1);
    await h.settle();
    h.sup.recordEgress({ type: 'request', cls: 'model', at: 6 });
    expect(h.state.report!.egress.model.requests).toBe(0);
    expect(h.state.report!.timestamps.firstModelRequestAt).toBeNull();
  });

  test('history is capped', async () => {
    const h = harness();
    for (let i = 0; i < 13; i++) {
      h.sup.dispatch();
      await h.until(() => h.state.status === 'running');
      h.fc.exits[i]!.resolve(1);
      await h.settle();
    }
    expect(h.state.report!.attempt).toBe(13);
    expect(h.state.reportHistory!.map(r => r.attempt)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('an orphaned run still gets a report, and it is delivered when the worker is known', async () => {
    const h = harness({ initial: { taskId: TASK_ID, attempt: 3, status: 'running', workerId: 'w-orphan', startedAt: 1_000, timings: { containerRunningAt: 2_000 } } });
    await h.sup.recoverOrphan();
    expect(h.state.report).toMatchObject({ attempt: 3, outcome: 'crashed', crashReport: 'sent', workerId: 'w-orphan', delivery: 'sent' });
    expect(h.state.report!.durationsMs.containerStart).toBe(1_000);
    expect(posts(h)).toHaveLength(1);
  });
});

describe('resumable runs: park and resume', () => {
  const failPatches = (h: { fetches: Array<{ url: string; init: RequestInit }> }) =>
    h.fetches.filter(f => f.init.method === 'PATCH');

  async function parkedHarness(config: Partial<SupervisorDeps['config']> = {}) {
    const h = harness({ config: { resumableRuns: true, ...config } });
    h.fc.setStdout(['BUILDD_WORKER_ID=worker-p1', 'BUILDD_PARKED=worker-p1']);
    h.sup.dispatch();
    await h.until(() => h.state.workerId === 'worker-p1');
    h.fc.exits[0]!.resolve(4);
    await h.settle();
    return h;
  }

  test('exit 4 is parked: container destroyed, no crash report, outcome in the report', async () => {
    const h = await parkedHarness();
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'parked', exitCode: 4, workerId: 'worker-p1' });
    expect(h.state.crashReport).toBeUndefined();
    expect(failPatches(h)).toHaveLength(0);
    expect(h.fc.calls.filter(c => c === 'destroy').length).toBeGreaterThanOrEqual(1);
    expect(h.fc.container.running).toBe(false);
    expect(h.state.report!.outcome).toBe('parked');
  });

  test('task.resume for the parked worker starts a new container that continues it', async () => {
    const h = await parkedHarness();
    const parkedAt = h.state.endedAt!;
    h.fc.setStdout([]);
    const r = h.sup.dispatch({ resumeWorkerId: 'worker-p1' });
    expect(r).toEqual({ accepted: true, attempt: 2 });
    await h.until(() => h.fc.execs.length === 2);
    expect(h.fc.execs[1]).toEqual(['buildd-once', '--resume-worker', 'worker-p1', '--task', TASK_ID]);
    expect(h.fc.starts).toHaveLength(2);
    expect(h.state).toMatchObject({ status: 'running', attempt: 2, workerId: 'worker-p1', resumed: true, parkedAt });
    h.fc.exits[1]!.resolve(0);
    await h.settle();
    expect(h.state.report!.resume.resumed).toBe(true);
    expect(h.state.report!.resume.gapMs).toBeGreaterThanOrEqual(0);
    expect(h.state.report!.workerId).toBe('worker-p1');
  });

  test('duplicate task.resume: exactly one run', async () => {
    const h = await parkedHarness();
    const a = h.sup.dispatch({ resumeWorkerId: 'worker-p1' });
    const b = h.sup.dispatch({ resumeWorkerId: 'worker-p1' });
    expect(a.accepted).toBe(true);
    expect(b).toMatchObject({ accepted: false, reason: 'already_live' });
    await h.until(() => h.fc.execs.length === 2);
    h.fc.exits[1]!.resolve(0);
    await h.settle();
    // A late duplicate after the resume finished is not a second resume.
    expect(h.sup.dispatch({ resumeWorkerId: 'worker-p1' })).toMatchObject({ accepted: false, reason: 'not_parked' });
    expect(h.fc.starts).toHaveLength(2);
  });

  test('task.resume naming another worker, or with nothing parked, is ignored', async () => {
    const h = await parkedHarness();
    expect(h.sup.dispatch({ resumeWorkerId: 'worker-other' })).toMatchObject({ accepted: false, reason: 'not_parked' });
    const fresh = harness({ config: { resumableRuns: true } });
    expect(fresh.sup.dispatch({ resumeWorkerId: 'worker-p1' })).toMatchObject({ accepted: false, reason: 'not_parked' });
    expect(fresh.fc.starts).toHaveLength(0);
  });

  test('orphan with resumable runs on and the container still running: park it, then resume it', async () => {
    const h = harness({ config: { resumableRuns: true }, initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 } });
    h.fc.markRunning();
    const recovering = h.sup.recoverOrphan();
    await h.until(() => h.fc.execs.length === 1);
    expect(h.fc.execs[0]).toEqual(['buildd-once', '--park-orphan', 'w-orph', '--task', TASK_ID]);
    h.fc.exits[0]!.resolve(4);
    await recovering;
    await h.until(() => h.fc.execs.length === 2);
    expect(h.fc.execs[1]).toEqual(['buildd-once', '--resume-worker', 'w-orph', '--task', TASK_ID]);
    expect(h.state).toMatchObject({ attempt: 2, resumed: true, workerId: 'w-orph' });
    expect(failPatches(h)).toHaveLength(0);
    h.fc.exits[1]!.resolve(0);
    await h.settle();
    expect(h.state.reportHistory?.at(-1)?.outcome).toBe('parked');
  });

  test('the orphan park gets a per-task token too, never the runner key', async () => {
    const h = harness({ config: { resumableRuns: true }, initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 } });
    h.fc.markRunning();
    const recovering = h.sup.recoverOrphan();
    await h.until(() => h.fc.execs.length === 1);
    const env = h.fc.execEnvs[0]!;
    expect(env.BUILDD_API_KEY).toBe('bldt_test_task_token');
    expect(Object.values(env).join('\n')).not.toContain('bld_test_key');
    h.fc.exits[0]!.resolve(4);
    await recovering;
    await h.until(() => h.fc.execs.length === 2);
  });

  test("the orphan park does not block the agent's start: the egress handler calls back into the agent", async () => {
    // onStart runs under blockConcurrencyWhile; the park's upload reaches the
    // snapshot route, which asks this agent for its scope. Awaiting the park
    // inside onStart deadlocks until the runtime resets the object.
    const h = harness({ config: { resumableRuns: true }, initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 } });
    h.fc.markRunning();
    let returned = false;
    const recovering = h.sup.recoverOrphan().then(() => { returned = true; });
    await h.until(() => h.fc.execs.length === 1);
    await recovering;
    expect(returned).toBe(true);
    expect(h.state.status).toBe('running'); // a duplicate dispatch meanwhile is still ignored
    expect(h.sup.dispatch()).toMatchObject({ accepted: false, reason: 'already_live' });
    h.fc.exits[0]!.resolve(4);
    await h.until(() => h.fc.execs.length === 2);
  });

  test('after a clean orphan park the agent marks the worker parked on buildd itself', async () => {
    const h = harness({ config: { resumableRuns: true }, initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 } });
    h.fc.markRunning();
    await h.sup.recoverOrphan();
    await h.until(() => h.fc.execs.length === 1);
    h.fc.exits[0]!.resolve(4);
    await h.until(() => h.fc.execs.length === 2);
    const marks = h.fetches.filter((f) => f.url.endsWith('/api/workers/w-orph/park'));
    expect(marks).toHaveLength(1);
    expect(marks[0]!.init.method).toBe('POST');
    expect((marks[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer bld_test_key');
  });

  test('an orphan park buildd refuses to mark is crashed, not resumed', async () => {
    const h = harness({
      config: { resumableRuns: true },
      initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 },
      fetchImpl: async (url) => new Response('{}', { status: url.endsWith('/park') ? 409 : 200 }),
    });
    h.fc.markRunning();
    await h.sup.recoverOrphan();
    await h.until(() => h.fc.execs.length === 1);
    h.fc.exits[0]!.resolve(4);
    await h.until(() => h.state.status === 'exited');
    await h.settle();
    expect(h.state).toMatchObject({ outcome: 'crashed' });
    expect(h.fc.execs).toHaveLength(1);
  });

  test('orphan park re-installs egress first: the restarted agent owns the snapshot route now', async () => {
    const h = harness({ config: { resumableRuns: true }, initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 } });
    h.fc.markRunning();
    const recovering = h.sup.recoverOrphan();
    await h.until(() => h.fc.execs.length === 1);
    expect(h.fc.calls.slice(0, 3)).toEqual(['mintTaskToken', 'installEgress', 'exec']);
    h.fc.exits[0]!.resolve(1);
    await recovering;
  });

  test('orphan park whose egress cannot be installed is crashed as before (no exec)', async () => {
    const h = harness({ egressFails: true, config: { resumableRuns: true }, initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 } });
    h.fc.markRunning();
    await h.sup.recoverOrphan();
    await h.settle();
    expect(h.fc.execs).toHaveLength(0);
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'crashed' });
  });

  test('orphan park that fails falls back to today: crashed and reported, no resume', async () => {
    const h = harness({ config: { resumableRuns: true }, initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 } });
    h.fc.markRunning();
    const recovering = h.sup.recoverOrphan();
    await h.until(() => h.fc.execs.length === 1);
    h.fc.exits[0]!.resolve(1);
    await recovering;
    await h.settle();
    expect(h.state).toMatchObject({ status: 'exited', outcome: 'crashed', crashReport: 'sent' });
    expect(h.fc.execs).toHaveLength(1);
    expect(h.fc.starts).toHaveLength(0);
  });

  test('orphan without resumable runs, or with the container gone, is crashed as before (no exec)', async () => {
    for (const resumableRuns of [false, true]) {
      const h = harness({ config: { resumableRuns }, initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 } });
      if (!resumableRuns) h.fc.markRunning();
      await h.sup.recoverOrphan();
      expect(h.state.outcome).toBe('crashed');
      expect(h.fc.execs).toHaveLength(0);
    }
  });
});

describe('scheduled dispatch (task.scheduled)', () => {
  const NOW = 1_000_000;
  const clock = () => { let t = NOW; return { now: () => t, set(v: number) { t = v; } }; };

  test('a future notBefore schedules a one-shot and records scheduledFor; nothing starts yet', async () => {
    const c = clock();
    const h = harness({ now: c.now });
    const r = await h.sup.scheduleDispatch(NOW + 300_000);
    expect(r).toEqual({ scheduled: true, scheduledFor: NOW + 300_000, replaced: false });
    expect([...h.sched.scheduled.values()]).toEqual([{ at: NOW + 300_000, payload: { notBefore: NOW + 300_000 } }]);
    expect(h.state.scheduledFor).toBe(NOW + 300_000);
    expect(h.state.scheduleId).toBe('sched-1');
    expect(h.sup.status().scheduledFor).toBe(NOW + 300_000);
    expect(h.fc.starts).toHaveLength(0);
  });

  test('a later task.scheduled replaces the earlier one (last write wins)', async () => {
    const h = harness({ now: () => NOW });
    await h.sup.scheduleDispatch(NOW + 300_000);
    const r = await h.sup.scheduleDispatch(NOW + 900_000);
    expect(r).toEqual({ scheduled: true, scheduledFor: NOW + 900_000, replaced: true });
    expect(h.sched.cancelled).toEqual(['sched-1']);
    expect([...h.sched.scheduled.keys()]).toEqual(['sched-2']);
    expect(h.state).toMatchObject({ scheduledFor: NOW + 900_000, scheduleId: 'sched-2' });
    // The replaced schedule firing anyway (its cancel lost) is a no-op.
    expect(h.sup.fireScheduledDispatch({ notBefore: NOW + 300_000 }, 'sched-1')).toMatchObject({ fired: false, reason: 'superseded' });
    expect(h.fc.starts).toHaveLength(0);
  });

  test('when it fires, the existing dispatch path starts the run; the report carries the time and the lateness', async () => {
    const c = clock();
    const h = harness({ now: c.now });
    await h.sup.scheduleDispatch(NOW + 300_000);
    c.set(NOW + 300_000 + 1_500);
    const r = h.sup.fireScheduledDispatch({ notBefore: NOW + 300_000 }, 'sched-1');
    expect(r).toEqual({ fired: true, accepted: true, attempt: 1 });
    expect(h.state.scheduledFor).toBeUndefined();
    expect(h.state.scheduleId).toBeUndefined();
    expect(h.state.timings?.scheduledFor).toBe(NOW + 300_000);
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(0);
    await h.settle();
    expect(h.state.report?.schedule).toEqual({ scheduledFor: NOW + 300_000, startedAt: NOW + 301_500, lateMs: 1_500 });
  });

  test('a live run makes the schedule a no-op when it fires, and clears it', async () => {
    const h = harness();
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    // The crash path: buildd requeues with a backoff while this run is still finishing.
    await h.sup.scheduleDispatch(Date.now() + 300_000);
    expect(h.state.status).toBe('running');
    expect(h.state.scheduleId).toBe('sched-1');
    const r = h.sup.fireScheduledDispatch({ notBefore: h.state.scheduledFor! }, 'sched-1');
    expect(r).toMatchObject({ fired: true, accepted: false, reason: 'already_live' });
    expect(h.state.scheduleId).toBeUndefined();
    expect(h.fc.starts).toHaveLength(1);
    h.fc.exits[0]!.resolve(0);
    await h.settle();
  });

  test('a schedule set during a live run survives that run ending, and fires the next attempt', async () => {
    const h = harness();
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    await h.sup.scheduleDispatch(Date.now() + 300_000);
    h.fc.exits[0]!.resolve(137);
    await h.settle();
    expect(h.state.status).toBe('exited');
    expect(h.state.scheduleId).toBe('sched-1');
    const r = h.sup.fireScheduledDispatch({ notBefore: h.state.scheduledFor! }, 'sched-1');
    expect(r).toEqual({ fired: true, accepted: true, attempt: 2 });
    await h.until(() => h.state.status === 'running');
    h.fc.exits[1]!.resolve(0);
    await h.settle();
  });

  test('a normal dispatch that starts a run consumes the pending schedule: it is cancelled and a late fire is a no-op', async () => {
    const h = harness();
    await h.sup.scheduleDispatch(Date.now() + 300_000);
    expect(h.sup.dispatch()).toEqual({ accepted: true, attempt: 1 });
    expect(h.state.scheduleId).toBeUndefined();
    expect(h.state.scheduledFor).toBeUndefined();
    await h.until(() => h.sched.cancelled.length === 1);
    expect(h.sched.cancelled).toEqual(['sched-1']);
    expect(h.sup.fireScheduledDispatch({ notBefore: 0 }, 'sched-1')).toMatchObject({ fired: false, reason: 'superseded' });
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(0);
    await h.settle();
    expect(h.fc.starts).toHaveLength(1);
    expect(h.state.report?.schedule).toEqual({ scheduledFor: null, startedAt: expect.any(Number), lateMs: null });
  });

  test('a notBefore already past dispatches now, through the same path', async () => {
    const h = harness({ now: () => NOW });
    await h.sup.scheduleDispatch(NOW + 300_000);
    const r = await h.sup.scheduleDispatch(NOW - 10);
    expect(r).toMatchObject({ scheduled: false, accepted: true, attempt: 1 });
    expect(h.sched.cancelled).toEqual(['sched-1']);
    expect(h.state.scheduleId).toBeUndefined();
    expect(h.state.timings?.scheduledFor).toBe(NOW - 10);
    await h.until(() => h.state.status === 'running');
    h.fc.exits[0]!.resolve(0);
    await h.settle();
  });

  test('a fire with no pending schedule (state lost or already consumed) starts nothing', () => {
    const h = harness();
    expect(h.sup.fireScheduledDispatch({ notBefore: 1 }, 'sched-9')).toMatchObject({ fired: false, reason: 'superseded' });
    expect(h.fc.starts).toHaveLength(0);
  });
});
