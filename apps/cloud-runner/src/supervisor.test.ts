/**
 * TaskSupervisor against a fake container: no Workers runtime, no Docker.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { INITIAL_STATE, buildContainerEnv, type RunState } from './lifecycle';
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
    /** A container left running from before an agent restart. */
    markRunning() { running = true; died = deferred<void>(); },
    get inactivityMs() { return inactivityMs; },
  };
}

function harness(opts: { config?: Partial<SupervisorDeps['config']>; fetchStatus?: number; fetchThrows?: boolean; initial?: RunState; egressFails?: boolean; fetchImpl?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
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
    installEgress: async () => {
      fc.calls.push('installEgress');
      if (opts.egressFails) throw new Error('interceptOutboundHttps failed');
    },
    fetch: (async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      if (opts.fetchImpl) return opts.fetchImpl(url, init);
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

  test('telemetry: no OTLP endpoint means the container env is exactly buildContainerEnv (pinned)', async () => {
    const h = harness({ config: { OTEL_LOG_TOOL_DETAILS: '1', OTEL_TRACES_BETA: '1', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' } });
    h.sup.dispatch();
    await h.until(() => h.state.status === 'running');
    expect(h.fc.starts[0]!.env).toEqual(buildContainerEnv({ BUILDD_SERVER: 'http://127.0.0.1:9', BUILDD_API_KEY: 'bld_test_key' }));
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
    expect(r.egress.github).toEqual({ requests: 1, rejected: 1, responseBytes: 0 });

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
      'BUILDD_REPO_SOURCE=warm',
      'BUILDD_METRIC=bogus 1',
    ]);
    h.sup.dispatch();
    await h.until(() => h.state.timings?.repoSource !== undefined);
    h.fc.exits[0]!.resolve(0);
    await h.settle();
    const r = h.state.report!;
    expect(r.repo).toEqual({ source: 'warm', fallbackReason: null, snapshotAgeMs: 7_200_000, bytes: { clone: null, restore: 5000, fetch: 64, cache: null, upload: null } });
    expect(r.durationsMs).toMatchObject({ restoreWarm: 400, fetch: 100, clone: null });
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

  test('orphan park that fails falls back to today: crashed and reported, no resume', async () => {
    const h = harness({ config: { resumableRuns: true }, initial: { taskId: TASK_ID, attempt: 1, status: 'running', workerId: 'w-orph', startedAt: 1 } });
    h.fc.markRunning();
    const recovering = h.sup.recoverOrphan();
    await h.until(() => h.fc.execs.length === 1);
    h.fc.exits[0]!.resolve(1);
    await recovering;
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
