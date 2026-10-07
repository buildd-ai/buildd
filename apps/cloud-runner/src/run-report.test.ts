import { describe, expect, test } from 'bun:test';
import * as runnerPhases from '../../runner/src/phase-lines';
import {
  METRIC_LINE_PREFIX,
  PHASE_LINE_PREFIX,
  REPO_FALLBACK_REASONS,
  REPO_SOURCE_LINE_PREFIX,
  RUN_METRICS,
  RUN_PHASES,
  parseMetricLine,
  parseRepoSourceLine,
  parseWarmUploadLine,
  parseCacheSkippedLine,
  CACHE_SKIPPED_LINE_PREFIX,
  CACHE_SKIP_PARTS,
  WARM_UPLOAD_LINE_PREFIX,
  WARM_UPLOAD_SKIP_REASONS,
  recordMetric,
  applyEgressEvent,
  assembleRunReport,
  countResponseBytes,
  measureResponse,
  deliverRunReport,
  egressClassForKind,
  emptyEgressDetail,
  applyEgressDetail,
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

  test('metric and repo source lines match phase-lines.ts and parse back', () => {
    expect(METRIC_LINE_PREFIX).toBe(runnerPhases.METRIC_LINE_PREFIX);
    expect([...RUN_METRICS]).toEqual([...runnerPhases.RUN_METRICS]);
    expect(REPO_SOURCE_LINE_PREFIX).toBe(runnerPhases.REPO_SOURCE_LINE_PREFIX);
    expect([...REPO_FALLBACK_REASONS]).toEqual([...runnerPhases.REPO_FALLBACK_REASONS]);
    for (const m of runnerPhases.RUN_METRICS) {
      expect(parseMetricLine(runnerPhases.formatMetricLine(m, 4096))).toEqual({ metric: m, value: 4096 });
    }
    expect(parseRepoSourceLine(runnerPhases.formatRepoSourceLine('warm'))).toEqual({ source: 'warm' });
    expect(parseRepoSourceLine(runnerPhases.formatRepoSourceLine('reuse'))).toEqual({ source: 'reuse' });
    for (const r of runnerPhases.REPO_FALLBACK_REASONS) {
      expect(parseRepoSourceLine(runnerPhases.formatRepoSourceLine('clone', r))).toEqual({ source: 'clone', reason: r });
    }
  });
});

describe('warm upload skip line (a repo over the warm snapshot cap)', () => {
  test('matches phase-lines.ts and parses back', () => {
    expect(WARM_UPLOAD_LINE_PREFIX).toBe(runnerPhases.WARM_UPLOAD_LINE_PREFIX);
    expect([...WARM_UPLOAD_SKIP_REASONS]).toEqual([...runnerPhases.WARM_UPLOAD_SKIP_REASONS]);
    for (const r of runnerPhases.WARM_UPLOAD_SKIP_REASONS) {
      expect(parseWarmUploadLine(runnerPhases.formatWarmUploadSkippedLine(r))).toEqual({ skipped: r });
    }
  });

  test.each(['BUILDD_WARM_UPLOAD=skipped', 'BUILDD_WARM_UPLOAD=skipped sk-ant-x', 'BUILDD_WARM_UPLOAD=done', '[warm] BUILDD_WARM_UPLOAD=skipped too_large'])('rejects %p', (line) => {
    expect(parseWarmUploadLine(line)).toBeNull();
  });

  test('the report says why there was no upload, and how big the repo measured', () => {
    const r = assembleRunReport({
      taskId: 'task-1', attempt: 1,
      timings: { runnerMetrics: { warm_repo_bytes: 2_600_000_000 }, warmUpload: { skipped: 'too_large' }, repoSource: { source: 'clone', reason: 'no_snapshot' } },
    });
    expect(r.repo.warmUploadSkipReason).toBe('too_large');
    expect(r.repo.bytes.warmRepo).toBe(2_600_000_000);
    const none = assembleRunReport({ taskId: 'task-1', attempt: 1 });
    expect(none.repo.warmUploadSkipReason).toBeNull();
    const hostile = assembleRunReport({ taskId: 'task-1', attempt: 1, timings: { warmUpload: { skipped: 'sk-ant-leak' } } } as unknown as RunReportInput);
    expect(hostile.repo.warmUploadSkipReason).toBeNull();
  });
});

describe('cache skipped line (a cache subtree left out of the warm upload for size)', () => {
  test('matches phase-lines.ts and parses back', () => {
    expect(CACHE_SKIPPED_LINE_PREFIX).toBe(runnerPhases.CACHE_SKIPPED_LINE_PREFIX);
    expect([...CACHE_SKIP_PARTS]).toEqual([...runnerPhases.CACHE_SKIP_PARTS]);
    for (const part of runnerPhases.CACHE_SKIP_PARTS) {
      expect(parseCacheSkippedLine(runnerPhases.formatCacheSkippedLine(part, 2_100_000_000, 1024 ** 3))).toEqual({ part, bytes: 2_100_000_000, cap: 1024 ** 3 });
    }
  });

  test.each([
    'BUILDD_CACHE_SKIPPED=pnpm-store',
    'BUILDD_CACHE_SKIPPED=pnpm-store 1',
    'BUILDD_CACHE_SKIPPED=node_modules 1 2',
    'BUILDD_CACHE_SKIPPED=pnpm-store -1 2',
    'BUILDD_CACHE_SKIPPED=pnpm-store 1 2 extra',
    '[warm] BUILDD_CACHE_SKIPPED=pnpm-store 1 2',
  ])('rejects %p', (line) => {
    expect(parseCacheSkippedLine(line)).toBeNull();
  });

  test('the report names the skipped part, its size and the cap, and times the cache restore', () => {
    const r = assembleRunReport({
      taskId: 'task-1', attempt: 1,
      timings: {
        cacheSkipped: { part: 'pnpm-store', bytes: 2_100_000_000, cap: 1024 ** 3 },
        runnerMetrics: { cache_raw_bytes: 900 },
        runnerPhases: { restore_cache_start: 1_000, restore_cache_end: 4_500 },
      },
    });
    expect(r.repo.cacheSkipped).toEqual({ part: 'pnpm-store', bytes: 2_100_000_000, cap: 1024 ** 3 });
    expect(r.repo.bytes.cacheRaw).toBe(900);
    expect(r.durationsMs.restoreCache).toBe(3_500);
    const none = assembleRunReport({ taskId: 'task-1', attempt: 1 });
    expect(none.repo.cacheSkipped).toBeNull();
    expect(none.durationsMs.restoreCache).toBeNull();
    const hostile = assembleRunReport({ taskId: 'task-1', attempt: 1, timings: { cacheSkipped: { part: 'sk-ant-x', bytes: 1, cap: 1 } } } as unknown as RunReportInput);
    expect(hostile.repo.cacheSkipped).toBeNull();
  });
});

describe('parseMetricLine / parseRepoSourceLine', () => {
  test.each([
    'BUILDD_METRIC=clone_bytes',
    'BUILDD_METRIC=clone_bytes -1',
    'BUILDD_METRIC=clone_bytes 1.5',
    'BUILDD_METRIC=secret_token 1',
    'BUILDD_METRIC=clone_bytes 1 extra',
    'BUILDD_METRIC=clone_bytes 99999999999999999',
    '[once] BUILDD_METRIC=clone_bytes 1',
  ])('metric rejects %p', (line) => {
    expect(parseMetricLine(line)).toBeNull();
  });

  test('metric accepts zero', () => {
    expect(parseMetricLine('BUILDD_METRIC=fetch_bytes 0')).toEqual({ metric: 'fetch_bytes', value: 0 });
  });

  test.each([
    'BUILDD_REPO_SOURCE=',
    'BUILDD_REPO_SOURCE=warm extra',
    'BUILDD_REPO_SOURCE=clone',
    'BUILDD_REPO_SOURCE=clone because-i-said-so',
    'BUILDD_REPO_SOURCE=tarball',
  ])('source rejects %p', (line) => {
    expect(parseRepoSourceLine(line)).toBeNull();
  });

  test('recordMetric: last value wins (a refresh overwrites nothing else)', () => {
    let m = recordMetric(undefined, 'fetch_bytes', 5);
    m = recordMetric(m, 'fetch_bytes', 7);
    expect(m).toEqual({ fetch_bytes: 7 });
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

describe('egress detail: why requests failed, never what they were', () => {
  test('reject reasons and upstream error statuses are counted per class', () => {
    const d = emptyEgressDetail();
    applyEgressDetail(d, { type: 'request', cls: 'model', at: 1, rejected: true, reason: 'path', pathLabel: 'api_hello' });
    applyEgressDetail(d, { type: 'request', cls: 'model', at: 2, rejected: true, reason: 'path', pathLabel: 'oauth' });
    applyEgressDetail(d, { type: 'request', cls: 'model', at: 3, rejected: true, reason: 'unconfigured' });
    applyEgressDetail(d, { type: 'status', cls: 'model', status: 403 });
    applyEgressDetail(d, { type: 'status', cls: 'model', status: 400 });
    applyEgressDetail(d, { type: 'status', cls: 'model', status: 200 });
    applyEgressDetail(d, { type: 'request', cls: 'github', at: 4 });
    expect(d.model).toEqual({ rejectReasons: { path: 2, unconfigured: 1 }, rejectedPaths: { api_hello: 1, oauth: 1 }, errorStatuses: { '400': 1, '403': 1 } });
    expect(d.github).toEqual({ rejectReasons: {}, rejectedPaths: {}, errorStatuses: {}, credentialed: 0, unauthenticated: {}, unauthenticatedErrorStatuses: {}, grantFetchFailures: {} });
  });

  test('github: credentialed vs unauthenticated (by fixed reason), and which answers came back unauthenticated', () => {
    const d = emptyEgressDetail();
    applyEgressDetail(d, { type: 'request', cls: 'github', at: 1, auth: 'credentialed' });
    applyEgressDetail(d, { type: 'request', cls: 'github', at: 2, auth: 'credentialed' });
    applyEgressDetail(d, { type: 'request', cls: 'github', at: 3, auth: 'grant_fetch_failed' });
    applyEgressDetail(d, { type: 'request', cls: 'github', at: 4, auth: 'out_of_scope' });
    applyEgressDetail(d, { type: 'request', cls: 'github', at: 5, auth: 'bogus' as never });
    applyEgressDetail(d, { type: 'status', cls: 'github', status: 429, auth: 'grant_fetch_failed' });
    applyEgressDetail(d, { type: 'status', cls: 'github', status: 429, auth: 'credentialed' });
    applyEgressDetail(d, { type: 'grant_failure', cls: 'github', status: 409 });
    applyEgressDetail(d, { type: 'grant_failure', cls: 'github', status: 0 });
    expect(d.github).toEqual({
      rejectReasons: {}, rejectedPaths: {},
      errorStatuses: { '429': 2 },
      credentialed: 2,
      unauthenticated: { grant_fetch_failed: 1, out_of_scope: 1, no_grant: 1 },
      unauthenticatedErrorStatuses: { '429': 1 },
      grantFetchFailures: { '409': 1, error: 1 },
    });
    // Model traffic never grows the GitHub-only fields.
    applyEgressDetail(d, { type: 'request', cls: 'model', at: 6, auth: 'no_grant' });
    expect(d.model).toEqual({ rejectReasons: {}, rejectedPaths: {}, errorStatuses: {} });
  });

  test('a grant_failure event is valid only for github, with an integer status', () => {
    expect(isEgressEvent({ type: 'grant_failure', cls: 'github', status: 409 })).toBe(true);
    expect(isEgressEvent({ type: 'grant_failure', cls: 'model', status: 409 })).toBe(false);
    expect(isEgressEvent({ type: 'grant_failure', cls: 'github', status: 'x' })).toBe(false);
  });

  test('a status event is a valid egress event; an unknown reason is not counted', () => {
    expect(isEgressEvent({ type: 'status', cls: 'model', status: 403 })).toBe(true);
    expect(isEgressEvent({ type: 'status', cls: 'model', status: 'x' })).toBe(false);
    const d = emptyEgressDetail();
    applyEgressDetail(d, { type: 'request', cls: 'model', at: 1, rejected: true, reason: 'nope' as never });
    expect(d.model.rejectReasons).toEqual({ other: 1 });
    applyEgressDetail(d, { type: 'request', cls: 'model', at: 2, rejected: true, reason: 'path', pathLabel: '/raw/path' as never });
    expect(d.model.rejectedPaths).toEqual({ other: 1 });
  });

  test('the report carries the detail, bounded to known reasons and 4xx/5xx codes', () => {
    const r = assembleRunReport({ ...FULL, egressDetail: {
      model: { rejectReasons: { path: 3, bogus: 9 } as never, rejectedPaths: { oauth: 3, '/x': 1 } as never, errorStatuses: { '403': 2, '200': 5, 'abc': 1 } },
    } as never });
    expect(r.egressDetail.model).toEqual({ rejectReasons: { path: 3 }, rejectedPaths: { oauth: 3 }, errorStatuses: { '403': 2 } });
    expect(r.egressDetail.github).toEqual({ rejectReasons: {}, rejectedPaths: {}, errorStatuses: {}, credentialed: 0, unauthenticated: {}, unauthenticatedErrorStatuses: {}, grantFetchFailures: {} });
  });

  test('the github auth fields survive the report, bounded to known reasons and codes', () => {
    const r = assembleRunReport({ ...FULL, egressDetail: {
      github: {
        rejectReasons: {}, rejectedPaths: {}, errorStatuses: { '429': 1 },
        credentialed: 4, unauthenticated: { grant_fetch_failed: 2, nope: 1 } as never,
        unauthenticatedErrorStatuses: { '429': 1, '200': 3 }, grantFetchFailures: { '409': 2, error: 1, '/x': 1 },
      },
    } as never });
    expect(r.egressDetail.github).toEqual({
      rejectReasons: {}, rejectedPaths: {}, errorStatuses: { '429': 1 },
      credentialed: 4, unauthenticated: { grant_fetch_failed: 2 },
      unauthenticatedErrorStatuses: { '429': 1 }, grantFetchFailures: { '409': 2, error: 1 },
    });
  });
});

describe('assembleRunReport', () => {
  test('timestamps, derived durations, ids, counters and outcome', () => {
    const r = assembleRunReport(FULL);
    expect(r).toMatchObject({
      kind: 'cloud-run-report',
      version: 11,
      taskId: 'task-1',
      attempt: 2,
      workerId: 'worker-9',
      containerInstanceId: 'abcdef0123456789',
      runLabel: 'task-1.2',
      instanceType: 'standard-1',
      timestamps: { dispatchReceivedAt: 1_000, containerRunningAt: 4_000, claimedAt: 6_000, firstModelRequestAt: 9_000, exitedAt: 60_000 },
      durationsMs: { containerStart: 3_000, toClaim: 2_000, clone: 500, install: 1_000, restoreWarm: null, fetch: null, warmUpload: null, park: null, restorePark: null, restoreCache: null, restoreReuse: null, toFirstModelRequest: 3_000, total: 59_000 },
      exitCode: 0,
      outcome: 'done',
      crashReport: null,
    });
    expect(r.egress.github).toEqual({ requests: 5, rejected: 1, responseBytes: 99 });
  });

  test('a scheduled start: the time it was scheduled for, the actual start and the lateness', () => {
    const r = assembleRunReport({ ...FULL, dispatchReceivedAt: 10_500, timings: { ...FULL.timings, scheduledFor: 10_000 } });
    expect(r.schedule).toEqual({ scheduledFor: 10_000, startedAt: 10_500, lateMs: 500 });
    // Not a scheduled start: no lateness to speak of.
    expect(assembleRunReport(FULL).schedule).toEqual({ scheduledFor: null, startedAt: 1_000, lateMs: null });
    // A start before the scheduled time (clock skew) is not negative lateness.
    expect(assembleRunReport({ ...FULL, dispatchReceivedAt: 9_000, timings: { scheduledFor: 10_000 } }).schedule.lateMs).toBeNull();
  });

  test('missing pieces are null, never guessed', () => {
    const r = assembleRunReport({ taskId: 'task-1', attempt: 1, dispatchReceivedAt: 1_000, timings: { exitedAt: 2_000, runnerPhases: { clone_start: 5 } }, exitCode: null, outcome: 'crashed', crashReport: 'no_worker_id' });
    expect(r.workerId).toBeNull();
    expect(r.durationsMs).toEqual({ containerStart: null, toClaim: null, clone: null, install: null, restoreWarm: null, fetch: null, warmUpload: null, park: null, restorePark: null, restoreCache: null, restoreReuse: null, toFirstModelRequest: null, total: 1_000 });
    expect(r.resume).toEqual({ resumed: false, gapMs: null, layer: null, parkBytes: null });
    expect(r.repo).toEqual({ source: null, fallbackReason: null, snapshotAgeMs: null, warmUploadSkipReason: null, cacheSkipped: null, bytes: { clone: null, restore: null, fetch: null, cache: null, cacheRaw: null, upload: null, warmRepo: null } });
    expect(r.exitCode).toBeNull();
    expect(r.crashReport).toBe('no_worker_id');
    expect(r.egress.model).toEqual({ requests: 0, rejected: 0, responseBytes: 0 });
  });

  test('deferredRetry: present only when an outcome actually deferred, sanitized and null-backoff past the cap', () => {
    expect(assembleRunReport(FULL).deferredRetry).toBeNull();
    expect(assembleRunReport({ ...FULL, outcome: 'deferred', deferredRetry: { retryNumber: 1, backoffMs: 30_000, reason: 'workspace_cap' } }).deferredRetry)
      .toEqual({ retryNumber: 1, backoffMs: 30_000, reason: 'workspace_cap' });
    expect(assembleRunReport({ ...FULL, outcome: 'start_deferred', deferredRetry: { retryNumber: 6, backoffMs: null, reason: 'container_capacity' } }).deferredRetry)
      .toEqual({ retryNumber: 6, backoffMs: null, reason: 'container_capacity' });
    // A reason that is not a short identifier (stray prose, a credential-shaped string) is dropped, not passed through.
    expect(assembleRunReport({ ...FULL, outcome: 'deferred', deferredRetry: { retryNumber: 1, backoffMs: 30_000, reason: 'not a valid reason!' } }).deferredRetry)
      .toEqual({ retryNumber: 1, backoffMs: 30_000, reason: null });
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
      'agentRestarts', 'attempt', 'containerInstanceId', 'crashReport', 'deferredRetry', 'durationsMs', 'egress', 'egressDetail', 'exitCode', 'instanceType', 'interruption', 'kind',
      'modelAuth', 'outcome', 'repo', 'resources', 'resume', 'reusedContainer', 'runLabel', 'runnerPhases', 'runnerSize', 'schedule', 'taskId', 'timestamps', 'version', 'workerId',
    ]);
  });

  test('modelAuth: a label only, null when unknown, and no token shape can get in', () => {
    expect(assembleRunReport(FULL).modelAuth).toBeNull();
    expect(assembleRunReport({ ...FULL, modelAuth: 'owner_seat' }).modelAuth).toBe('owner_seat');
    expect(assembleRunReport({ ...FULL, modelAuth: 'metered' }).modelAuth).toBe('metered');
    const hostile = assembleRunReport({ ...FULL, modelAuth: 'sk-ant-oat01-owner-seat-secret' } as unknown as RunReportInput);
    expect(hostile.modelAuth).toBeNull();
    expect(JSON.stringify(hostile)).not.toContain('sk-ant-oat01');
  });

  test('agentRestarts: sanitized, capped, empty by default', () => {
    expect(assembleRunReport(FULL).agentRestarts).toEqual([]);
    const ok = { at: 5_000, recovery: 'reattached', containerRunning: true, runningForMs: 900, versionChanged: false } as const;
    const r = assembleRunReport({
      ...FULL,
      agentRestarts: [ok, { ...ok, recovery: 'oom' as never }, { ...ok, at: -1 }, { ...ok, versionChanged: 'yes' as never, containerRunning: 'x' as never }],
    });
    expect(r.agentRestarts).toEqual([ok, { at: 5_000, recovery: 'reattached', containerRunning: false, runningForMs: 900, versionChanged: null }]);
  });

  test('resources: memory peak and limit, disk minimum and total, from the runner metric lines', () => {
    const r = assembleRunReport({ ...FULL, timings: { ...FULL.timings, runnerMetrics: { mem_peak_bytes: 4_000_000_000, mem_limit_bytes: 4_294_967_296, disk_free_min_bytes: 2_500_000_000, disk_total_bytes: 8_000_000_000 } } });
    expect(r.resources).toEqual({ memoryPeakBytes: 4_000_000_000, memoryLimitBytes: 4_294_967_296, diskFreeMinBytes: 2_500_000_000, diskTotalBytes: 8_000_000_000 });
    expect(assembleRunReport(FULL).resources).toEqual({ memoryPeakBytes: null, memoryLimitBytes: null, diskFreeMinBytes: null, diskTotalBytes: null });
  });

  test('interruption: from the closed list only', () => {
    expect(assembleRunReport(FULL).interruption).toBeNull();
    for (const i of ['container_stopped', 'agent_restart', 'question'] as const) {
      expect(assembleRunReport({ ...FULL, interruption: i }).interruption).toBe(i);
    }
    expect(assembleRunReport({ ...FULL, interruption: 'oom' as never }).interruption).toBeNull();
  });

  test('runnerSize: the class actually used, the decision that chose it, and weighted runner-seconds', () => {
    // FULL: container running at 4 s, exited at 60 s -> 56 runner-seconds.
    const large = assembleRunReport({ ...FULL, runnerSize: 'large', runnerSizeDecision: { size: 'large', source: 'derived', reason: 'low_disk' } });
    expect(large.runnerSize).toEqual({ size: 'large', source: 'derived', reason: 'low_disk', weight: 2, runnerSeconds: 56, weightedRunnerSeconds: 112 });
    const standard = assembleRunReport({ ...FULL, runnerSize: 'standard' });
    expect(standard.runnerSize).toEqual({ size: 'standard', source: null, reason: null, weight: 1, runnerSeconds: 56, weightedRunnerSeconds: 56 });
    // No class given: standard (the only class before there were two).
    expect(assembleRunReport(FULL).runnerSize.size).toBe('standard');
    // The container never ran: no runner-seconds.
    expect(assembleRunReport({ taskId: 'task-1', attempt: 1, runnerSize: 'large' }).runnerSize).toMatchObject({ runnerSeconds: null, weightedRunnerSeconds: null });
  });

  test('warm restore: source, timings and bytes for restore, fetch and upload', () => {
    const r = assembleRunReport({
      ...FULL,
      timings: {
        ...FULL.timings,
        runnerPhases: { restore_warm_start: 5_000, restore_warm_end: 5_300, fetch_start: 5_300, fetch_end: 5_400, warm_upload_start: 59_000, warm_upload_end: 59_800 },
        runnerMetrics: { restore_bytes: 1_000_000, fetch_bytes: 2_048, cache_bytes: 500_000, snapshot_age_ms: 3_600_000, warm_upload_bytes: 0 },
        repoSource: { source: 'warm' },
      },
    });
    expect(r.durationsMs).toMatchObject({ clone: null, restoreWarm: 300, fetch: 100, warmUpload: 800 });
    expect(r.repo).toEqual({
      source: 'warm', fallbackReason: null, snapshotAgeMs: 3_600_000, warmUploadSkipReason: null, cacheSkipped: null,
      bytes: { clone: null, restore: 1_000_000, fetch: 2_048, cache: 500_000, cacheRaw: null, upload: 0, warmRepo: null },
    });
  });

  test('a resumed attempt: flag, gap from the parked attempt to this dispatch, layer, park timings', () => {
    const r = assembleRunReport({
      ...FULL,
      resumed: true,
      parkedAt: 400,
      timings: {
        ...FULL.timings,
        runnerPhases: { restore_park_start: 5_000, restore_park_end: 5_250, park_start: 50_000, park_end: 50_900 },
        runnerMetrics: { resume_layer: 1, park_bytes: 4096 },
      },
    });
    expect(r.resume).toEqual({ resumed: true, gapMs: 600, layer: 1, parkBytes: 4096 });
    expect(r.durationsMs).toMatchObject({ restorePark: 250, park: 900 });
    expect(r.outcome).toBe('done');
    expect(assembleRunReport({ ...FULL, outcome: 'parked' }).outcome).toBe('parked');
  });

  test('no gap without a resume, and only layers 1 and 2', () => {
    expect(assembleRunReport({ ...FULL, parkedAt: 400 }).resume.gapMs).toBeNull();
    expect(assembleRunReport({ ...FULL, resumed: true, timings: { runnerMetrics: { resume_layer: 7 } } }).resume.layer).toBeNull();
  });

  test('clone fallback: the reason is kept, from the closed list only', () => {
    const base = { ...FULL, timings: { ...FULL.timings, runnerMetrics: { clone_bytes: 42 }, repoSource: { source: 'clone' as const, reason: 'no_snapshot' as const } } };
    expect(assembleRunReport(base).repo).toMatchObject({ source: 'clone', fallbackReason: 'no_snapshot', bytes: { clone: 42 } });
    const hostile = { ...base, timings: { ...base.timings, repoSource: { source: 'clone', reason: 'sk-ant-leak' }, runnerMetrics: { clone_bytes: 'x', evil: 5 } } } as unknown as RunReportInput;
    const r = assembleRunReport(hostile);
    expect(r.repo.fallbackReason).toBeNull();
    expect(r.repo.bytes.clone).toBeNull();
    expect(JSON.stringify(r)).not.toContain('sk-ant');
    expect(JSON.stringify(r)).not.toContain('evil');
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

describe('measureResponse: GitHub and passthrough bodies are never piped through JavaScript', () => {
  // A JS pass-through costs Worker CPU per chunk: a ~1.5 GB git pack through
  // it exceeded the invocation's CPU limit and the clone was cut near the end.
  test('github and passthrough: the upstream Response itself is returned, bytes taken from content-length', () => {
    for (const cls of ['github', 'passthrough'] as const) {
      const seen: number[] = [];
      const res = new Response('x'.repeat(10), { headers: { 'content-length': '10' } });
      expect(measureResponse(res, cls, n => seen.push(n))).toBe(res);
      expect(seen).toEqual([10]);
    }
  });

  test('github without content-length (chunked): returned untouched, nothing counted', () => {
    const seen: number[] = [];
    const res = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); c.close(); } }));
    expect(measureResponse(res, 'github', n => seen.push(n))).toBe(res);
    expect(seen).toEqual([]);
  });

  test('model responses are small and keep exact counting', async () => {
    const seen: number[] = [];
    const out = measureResponse(new Response('hello world'), 'model', n => seen.push(n));
    expect(await out.text()).toBe('hello world');
    expect(seen).toEqual([11]);
  });
});
