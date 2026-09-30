import { describe, expect, test } from 'bun:test';
import * as runnerPhases from '../../runner/src/phase-lines';
import {
  PHASE_LINE_PREFIX,
  RUN_PHASES,
  applyEgressEvent,
  assembleRunReport,
  countResponseBytes,
  deliverRunReport,
  egressClassForKind,
  emptyEgressCounters,
  isEgressEvent,
  parsePhaseLine,
  recordPhase,
  reportArtifactKey,
  runReportArtifactRequest,
  type RunReportInput,
} from './run-report';

describe('phase line contract with apps/runner', () => {
  test('prefix and phase names match phase-lines.ts', () => {
    expect(PHASE_LINE_PREFIX).toBe(runnerPhases.PHASE_LINE_PREFIX);
    expect([...RUN_PHASES]).toEqual([...runnerPhases.RUN_PHASES]);
  });

  test('every line the runner formats parses back', () => {
    for (const p of runnerPhases.RUN_PHASES) {
      expect(parsePhaseLine(runnerPhases.formatPhaseLine(p, 1_700_000_000_000))).toEqual({ phase: p, at: 1_700_000_000_000 });
    }
  });
});

describe('parsePhaseLine', () => {
  test('accepts the exact format, with surrounding whitespace', () => {
    expect(parsePhaseLine('BUILDD_PHASE=clone_end 1700000000123')).toEqual({ phase: 'clone_end', at: 1700000000123 });
    expect(parsePhaseLine('  BUILDD_PHASE=install_start 5\r')).toEqual({ phase: 'install_start', at: 5 });
  });

  test.each([
    'BUILDD_PHASE=clone_start',
    'BUILDD_PHASE=clone_start abc',
    'BUILDD_PHASE=unknown_phase 1',
    'BUILDD_PHASE=clone_start 1 extra',
    'BUILDD_PHASE=clone_start 0',
    'xBUILDD_PHASE=clone_start 1',
    '[once] BUILDD_PHASE=clone_start 1',
    'BUILDD_PHASE=clone_start 99999999999999999',
  ])('rejects %p', (line) => {
    expect(parsePhaseLine(line)).toBeNull();
  });

  test('recordPhase keeps the first occurrence', () => {
    let p = recordPhase(undefined, 'clone_start', 10);
    p = recordPhase(p, 'clone_start', 20);
    p = recordPhase(p, 'clone_end', 30);
    expect(p).toEqual({ clone_start: 10, clone_end: 30 });
  });
});

describe('egress counters', () => {
  test('requests, rejections and bytes accumulate per class', () => {
    const c = emptyEgressCounters();
    applyEgressEvent(c, { type: 'request', cls: 'model', at: 1 });
    applyEgressEvent(c, { type: 'request', cls: 'model', at: 2, rejected: true });
    applyEgressEvent(c, { type: 'bytes', cls: 'model', bytes: 100.7 });
    applyEgressEvent(c, { type: 'request', cls: 'github', at: 3 });
    expect(c).toEqual({
      model: { requests: 2, rejected: 1, responseBytes: 100 },
      github: { requests: 1, rejected: 0, responseBytes: 0 },
      passthrough: { requests: 0, rejected: 0, responseBytes: 0 },
    });
  });

  test('host kinds map to classes', () => {
    expect(egressClassForKind('anthropic')).toBe('model');
    expect(egressClassForKind('github')).toBe('github');
    expect(egressClassForKind('passthrough')).toBe('passthrough');
  });

  test('isEgressEvent rejects anything but the two shapes', () => {
    expect(isEgressEvent({ type: 'request', cls: 'model', at: 1 })).toBe(true);
    expect(isEgressEvent({ type: 'bytes', cls: 'github', bytes: 0 })).toBe(true);
    expect(isEgressEvent({ type: 'request', cls: 'other', at: 1 })).toBe(false);
    expect(isEgressEvent({ type: 'bytes', cls: 'model', bytes: -1 })).toBe(false);
    expect(isEgressEvent({ type: 'bytes', cls: 'model', bytes: Number.NaN })).toBe(false);
    expect(isEgressEvent(null)).toBe(false);
  });

  test('countResponseBytes reports the body length once it is read, keeping status and headers', async () => {
    const seen: number[] = [];
    const res = countResponseBytes(new Response('hello world', { status: 201, headers: { 'x-a': 'b' } }), n => seen.push(n));
    expect(res.status).toBe(201);
    expect(res.headers.get('x-a')).toBe('b');
    expect(seen).toEqual([]);
    expect(await res.text()).toBe('hello world');
    expect(seen).toEqual([11]);
  });

  test('countResponseBytes with no body reports 0 at once', () => {
    const seen: number[] = [];
    countResponseBytes(new Response(null, { status: 204 }), n => seen.push(n));
    expect(seen).toEqual([0]);
  });
});

const FULL: RunReportInput = {
  taskId: 'task-1',
  attempt: 2,
  workerId: 'worker-9',
  containerInstanceId: 'abcdef0123456789',
  instanceType: 'standard-1',
  dispatchReceivedAt: 1_000,
  timings: {
    containerRunningAt: 4_000,
    claimedAt: 6_000,
    firstModelRequestAt: 9_000,
    exitedAt: 60_000,
    runnerPhases: { clone_start: 5_000, clone_end: 5_500, install_start: 7_000, install_end: 8_000 },
  },
  egress: {
    model: { requests: 3, rejected: 0, responseBytes: 1234 },
    github: { requests: 5, rejected: 1, responseBytes: 99 },
    passthrough: { requests: 0, rejected: 0, responseBytes: 0 },
  },
  exitCode: 0,
  outcome: 'done',
};

describe('assembleRunReport', () => {
  test('timestamps, derived durations, ids, counters and outcome', () => {
    const r = assembleRunReport(FULL);
    expect(r).toMatchObject({
      kind: 'cloud-run-report',
      version: 1,
      taskId: 'task-1',
      attempt: 2,
      workerId: 'worker-9',
      containerInstanceId: 'abcdef0123456789',
      runLabel: 'task-1.2',
      instanceType: 'standard-1',
      timestamps: { dispatchReceivedAt: 1_000, containerRunningAt: 4_000, claimedAt: 6_000, firstModelRequestAt: 9_000, exitedAt: 60_000 },
      durationsMs: { containerStart: 3_000, toClaim: 2_000, clone: 500, install: 1_000, toFirstModelRequest: 3_000, total: 59_000 },
      exitCode: 0,
      outcome: 'done',
      crashReport: null,
    });
    expect(r.egress.github).toEqual({ requests: 5, rejected: 1, responseBytes: 99 });
  });

  test('missing pieces are null, never guessed', () => {
    const r = assembleRunReport({ taskId: 'task-1', attempt: 1, dispatchReceivedAt: 1_000, timings: { exitedAt: 2_000, runnerPhases: { clone_start: 5 } }, exitCode: null, outcome: 'crashed', crashReport: 'no_worker_id' });
    expect(r.workerId).toBeNull();
    expect(r.durationsMs).toEqual({ containerStart: null, toClaim: null, clone: null, install: null, toFirstModelRequest: null, total: 1_000 });
    expect(r.exitCode).toBeNull();
    expect(r.crashReport).toBe('no_worker_id');
    expect(r.egress.model).toEqual({ requests: 0, rejected: 0, responseBytes: 0 });
  });

  test('a secret-looking value passed in any field cannot end up in the report', () => {
    const secrets = [
      'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'Bearer bld_0123456789abcdef',
      'ghs_16C7e42F292c6912E7710c838347Ae178B4a',
      'https://user:pass@example.com/x',
      'x-access-token:abc@github.com',
    ];
    for (const s of secrets) {
      const hostile = {
        ...FULL,
        taskId: s,
        workerId: s,
        containerInstanceId: s,
        instanceType: s,
        outcome: s,
        crashReport: s,
        exitCode: s,
        dispatchReceivedAt: s,
        timings: { ...FULL.timings, claimedAt: s, runnerPhases: { clone_start: s } },
        egress: { model: { requests: s, rejected: s, responseBytes: s } },
        // Extra keys a caller might carelessly spread in.
        headers: { authorization: s },
        url: s,
        body: s,
        outputTail: [s],
      } as unknown as RunReportInput;
      const json = JSON.stringify(assembleRunReport(hostile));
      expect(json).not.toContain(s);
      for (const needle of ['sk-ant', 'bld_', 'ghs_', 'Bearer', 'pass@', 'access-token', 'authorization', 'outputTail']) {
        expect(json).not.toContain(needle);
      }
    }
  });

  test('only allowlisted top-level keys', () => {
    expect(Object.keys(assembleRunReport({ ...FULL, extra: 'x' } as RunReportInput)).sort()).toEqual([
      'attempt', 'containerInstanceId', 'crashReport', 'durationsMs', 'egress', 'exitCode', 'instanceType', 'kind',
      'outcome', 'runLabel', 'runnerPhases', 'taskId', 'timestamps', 'version', 'workerId',
    ]);
  });
});

describe('delivery', () => {
  const report = assembleRunReport(FULL);

  test('the artifact request: worker route, data type, per-worker key, bearer runner key', () => {
    const req = runReportArtifactRequest('http://buildd.test/', 'bld_runner', report)!;
    expect(req.url).toBe('http://buildd.test/api/workers/worker-9/artifacts');
    expect(req.init.method).toBe('POST');
    expect((req.init.headers as Record<string, string>).Authorization).toBe('Bearer bld_runner');
    const body = JSON.parse(req.init.body as string);
    expect(body).toMatchObject({ type: 'data', key: 'cloud-run-report:worker-9' });
    expect(body.metadata.kind).toBe('cloud-run-report');
    expect(body.metadata.report).toEqual(report);
    expect(JSON.parse(body.content)).toEqual(report);
    expect(reportArtifactKey('w')).toBe('cloud-run-report:w');
  });

  test('no worker: nothing to attach it to', async () => {
    const calls: unknown[] = [];
    const deps = { fetch: (async () => { calls.push(1); return new Response('{}'); }) as unknown as typeof fetch, sleep: async () => {}, log: () => {} };
    expect(runReportArtifactRequest('http://x', 'k', { ...report, workerId: null })).toBeNull();
    expect(await deliverRunReport(deps, { server: 'http://x', apiKey: 'k' }, { ...report, workerId: null })).toBe('no_worker_id');
    expect(await deliverRunReport(deps, { server: undefined, apiKey: 'k' }, report)).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  function stub(responses: Array<number | 'throw'>) {
    const calls: string[] = [];
    let sleeps = 0;
    return {
      calls,
      get sleeps() { return sleeps; },
      deps: {
        fetch: (async (url: string) => {
          calls.push(url);
          const next = responses.shift();
          if (next === 'throw' || next === undefined) throw new Error('network down');
          return new Response('{}', { status: next });
        }) as unknown as typeof fetch,
        sleep: async () => { sleeps++; },
        log: () => {},
      },
    };
  }

  test('sent on the first 2xx', async () => {
    const s = stub([200]);
    expect(await deliverRunReport(s.deps, { server: 'http://x', apiKey: 'k' }, report)).toBe('sent');
    expect(s.calls).toHaveLength(1);
  });

  test('a 4xx is final: not retried', async () => {
    const s = stub([403, 200]);
    expect(await deliverRunReport(s.deps, { server: 'http://x', apiKey: 'k' }, report)).toBe('rejected');
    expect(s.calls).toHaveLength(1);
  });

  test('a network error or 5xx is retried exactly once', async () => {
    const a = stub(['throw', 200]);
    expect(await deliverRunReport(a.deps, { server: 'http://x', apiKey: 'k' }, report)).toBe('sent');
    expect(a.calls).toHaveLength(2);
    expect(a.sleeps).toBe(1);

    const b = stub([503, 503, 503]);
    expect(await deliverRunReport(b.deps, { server: 'http://x', apiKey: 'k' }, report)).toBe('rejected');
    expect(b.calls).toHaveLength(2);

    const c = stub(['throw', 'throw', 'throw']);
    expect(await deliverRunReport(c.deps, { server: 'http://x', apiKey: 'k' }, report)).toBe('error');
    expect(c.calls).toHaveLength(2);
  });
});

describe('instance type config', () => {
  test('CONTAINER_INSTANCE_TYPE mirrors the container instance_type in wrangler.jsonc', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const text = readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const cfg = JSON.parse(text) as { containers: Array<{ instance_type: string }>; vars: Record<string, string> };
    expect(cfg.vars.CONTAINER_INSTANCE_TYPE).toBe(cfg.containers[0]!.instance_type);
  });
});
