import { describe, expect, test } from 'bun:test';
import {
  CSV_COLUMNS,
  GraphqlError,
  analyticsWindow,
  causeOf,
  estimateCost,
  joinRuns,
  metricsQuery,
  parseEvalArgs,
  parseMetricsResponse,
  parseUsageResponse,
  percentile,
  reportsFromArtifacts,
  reportsInWindow,
  summaryMarkdown,
  toCsv,
  usageQuery,
  type MetricsGroup,
  type UsageGroup,
} from './eval-report';
import { assembleRunReport, type RunReport } from './run-report';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');

function report(over: { taskId?: string; attempt?: number; workerId?: string | null; instance?: string; start?: number; durS?: number; outcome?: RunReport['outcome'] & string; exitCode?: number | null; clone?: number; crash?: 'sent' | 'no_worker_id' } = {}): RunReport {
  const start = over.start ?? T0;
  return assembleRunReport({
    taskId: over.taskId ?? 'task-a',
    attempt: over.attempt ?? 1,
    workerId: over.workerId === undefined ? 'worker-a' : over.workerId,
    containerInstanceId: over.instance ?? 'inst-a',
    instanceType: 'standard-1',
    dispatchReceivedAt: start,
    timings: {
      containerRunningAt: start + 2_000,
      claimedAt: start + 5_000,
      firstModelRequestAt: start + 9_000,
      exitedAt: start + (over.durS ?? 120) * 1000,
      runnerPhases: { clone_start: start + 3_000, clone_end: start + 3_000 + (over.clone ?? 1_000) },
    },
    egress: { model: { requests: 4, rejected: 0, responseBytes: 4000 }, github: { requests: 2, rejected: 0, responseBytes: 200 }, passthrough: { requests: 0, rejected: 0, responseBytes: 0 } },
    exitCode: over.exitCode === undefined ? 0 : over.exitCode,
    outcome: over.outcome ?? 'done',
    crashReport: over.crash,
  });
}

describe('percentile', () => {
  test('linear interpolation between closest ranks', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBe(46);
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 100)).toBe(5);
    expect(percentile([1, Number.NaN, 3], 50)).toBe(2);
  });
});

describe('estimateCost', () => {
  test('list prices: $0.0000025/GiB-s memory, $0.00002/vCPU-s, $0.00000007/GB-s disk', () => {
    // 1 hour of 4 GiB, 8 GB disk, 600 active vCPU-seconds.
    const c = estimateCost({ cpuTimeSec: 600, allocatedMemory: 4 * 1024 ** 3 * 3600, allocatedDisk: 8e9 * 3600, txBytes: 0 });
    expect(c.memoryUsd).toBeCloseTo(4 * 3600 * 0.0000025, 12);
    expect(c.vcpuUsd).toBeCloseTo(600 * 0.00002, 12);
    expect(c.diskUsd).toBeCloseTo(8 * 3600 * 0.00000007, 12);
    expect(c.totalUsd).toBeCloseTo(0.036 + 0.012 + 0.002016, 12);
  });
});

describe('reportsFromArtifacts', () => {
  test('metadata.report first, then content JSON; others skipped; one per worker', () => {
    const a = report({ workerId: 'w-1' });
    const b = report({ workerId: 'w-2' });
    const out = reportsFromArtifacts([
      { key: 'cloud-run-report:w-1', metadata: { kind: 'cloud-run-report', report: a } },
      { key: 'cloud-run-report:w-2', metadata: null, content: JSON.stringify(b) },
      { key: 'cloud-run-report:w-2', metadata: { report: b } },
      { key: 'other', content: 'not json' },
      { key: 'other', metadata: { report: { kind: 'something-else' } } },
    ]);
    expect(out.map(r => r.workerId)).toEqual(['w-1', 'w-2']);
  });

  test('reportsInWindow keeps runs dispatched in [since, until)', () => {
    const rs = [report({ start: T0 - 1 }), report({ start: T0 }), report({ start: T0 + 10 })];
    expect(reportsInWindow(rs, T0, T0 + 10).map(r => r.timestamps.dispatchReceivedAt)).toEqual([T0]);
  });
});

describe('GraphQL queries use only documented fields', () => {
  test('metrics', () => {
    const q = metricsQuery(true);
    expect(q).toContain('containersMetricsAdaptiveGroups');
    expect(q).toContain('datetime_geq: $start, datetime_leq: $end');
    expect(q).toContain('sum { cpuTimeSec rxBytes txBytes }');
    expect(q).toContain('max { memory }');
    expect(q).toContain('run: label(name: "bd_run")');
    expect(metricsQuery(false)).not.toContain('label(');
  });

  test('usage', () => {
    const q = usageQuery(true);
    expect(q).toContain('containersUsageAdaptiveGroups');
    expect(q).toContain('date_geq: $startDate, date_leq: $endDate');
    expect(q).toContain('sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }');
    expect(usageQuery(false)).not.toContain('label(');
  });
});

const METRICS_RESPONSE = {
  data: {
    viewer: {
      accounts: [{
        containersMetricsAdaptiveGroups: [
          { dimensions: { instanceId: 'inst-a', datetimeMinute: '2026-09-01T10:00:00Z', run: 'task-a.1' }, sum: { cpuTimeSec: 10, rxBytes: 100, txBytes: 10 }, max: { memory: 1000 } },
          { dimensions: { instanceId: 'inst-a', datetimeMinute: '2026-09-01T10:01:00Z', run: 'task-a.1' }, sum: { cpuTimeSec: 20, rxBytes: 200, txBytes: 20 }, max: { memory: 3000 } },
          { dimensions: { instanceId: 'inst-b', datetimeMinute: '2026-09-01T10:00:00Z', run: '' }, sum: { cpuTimeSec: 5 }, max: {} },
        ],
      }],
    },
  },
  errors: null,
};

describe('parse GraphQL responses', () => {
  test('metrics groups', () => {
    const g = parseMetricsResponse(METRICS_RESPONSE);
    expect(g).toHaveLength(3);
    expect(g[0]).toEqual({ instanceId: 'inst-a', run: 'task-a.1', minute: T0, cpuTimeSec: 10, rxBytes: 100, txBytes: 10, memoryMax: 1000 });
    expect(g[2]).toEqual({ instanceId: 'inst-b', run: null, minute: T0, cpuTimeSec: 5, rxBytes: 0, txBytes: 0, memoryMax: null });
  });

  test('usage groups', () => {
    const g = parseUsageResponse({ data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: [
      { dimensions: { instanceId: 'inst-a', date: '2026-09-01', run: 'task-a.1' }, sum: { cpuTimeSec: 31, allocatedMemory: 5e11, allocatedDisk: 1e12, txBytes: 9 } },
    ] }] } } });
    expect(g).toEqual([{ instanceId: 'inst-a', run: 'task-a.1', date: '2026-09-01', cpuTimeSec: 31, allocatedMemory: 5e11, allocatedDisk: 1e12, txBytes: 9 }]);
  });

  test('GraphQL errors and malformed bodies throw', () => {
    expect(() => parseMetricsResponse({ data: null, errors: [{ message: 'unknown field label' }] })).toThrow(GraphqlError);
    expect(() => parseMetricsResponse({ data: null, errors: [{ message: 'unknown field label' }] })).toThrow('unknown field label');
    expect(() => parseUsageResponse({})).toThrow(GraphqlError);
    expect(parseUsageResponse({ data: { viewer: { accounts: [] } } })).toEqual([]);
  });
});

describe('joinRuns', () => {
  test('by label: metrics summed, peak and average of minute peaks, cost from usage', () => {
    const r = report();
    const usage: UsageGroup[] = [{ instanceId: 'inst-a', run: 'task-a.1', date: '2026-09-01', cpuTimeSec: 31, allocatedMemory: 1024 ** 3 * 100, allocatedDisk: 1e9 * 100, txBytes: 0 }];
    const [row] = joinRuns([r], parseMetricsResponse(METRICS_RESPONSE), usage);
    expect(row!.match).toBe('label');
    expect(row!.metrics).toEqual({ vcpuSecondsActive: 30, memoryPeak: 3000, memoryAvg: 2000, rxBytes: 300, txBytes: 30, minutes: 2 });
    expect(row!.cost!.totalUsd).toBeCloseTo(100 * 0.0000025 + 31 * 0.00002 + 100 * 0.00000007, 12);
  });

  test('without labels: instance + time window for metrics; usage only when the day is not shared', () => {
    const a1 = report({ taskId: 'task-a', attempt: 1, instance: 'inst-x', start: T0, durS: 60 });
    const a2 = report({ taskId: 'task-a', attempt: 2, instance: 'inst-x', start: T0 + 3_600_000, durS: 60, workerId: 'worker-b' });
    const metrics: MetricsGroup[] = [
      { instanceId: 'inst-x', run: null, minute: T0, cpuTimeSec: 1, rxBytes: 0, txBytes: 0, memoryMax: 10 },
      { instanceId: 'inst-x', run: null, minute: T0 + 3_600_000, cpuTimeSec: 2, rxBytes: 0, txBytes: 0, memoryMax: 20 },
      { instanceId: 'inst-y', run: null, minute: T0, cpuTimeSec: 99, rxBytes: 0, txBytes: 0, memoryMax: 99 },
    ];
    const usage: UsageGroup[] = [{ instanceId: 'inst-x', run: null, date: '2026-09-01', cpuTimeSec: 3, allocatedMemory: 1, allocatedDisk: 1, txBytes: 0 }];
    const rows = joinRuns([a1, a2], metrics, usage);
    expect(rows.map(r => r.match)).toEqual(['instance_window', 'instance_window']);
    expect(rows.map(r => r.metrics!.vcpuSecondsActive)).toEqual([1, 2]);
    // Both attempts ran on the same instance the same day: daily usage cannot be split.
    expect(rows.map(r => r.usage)).toEqual([null, null]);

    const [solo] = joinRuns([a1], metrics, usage);
    expect(solo!.usage!.cpuTimeSec).toBe(3);
  });

  test('no analytics: report-only row', () => {
    const [row] = joinRuns([report()], [], []);
    expect(row).toMatchObject({ match: 'none', metrics: null, usage: null, cost: null });
  });
});

describe('output', () => {
  const rows = joinRuns([
    report({ taskId: 'task-a', clone: 1_000, durS: 100 }),
    report({ taskId: 'task-b', workerId: 'worker-b', clone: 3_000, durS: 300, outcome: 'failed', exitCode: 1 }),
    report({ taskId: 'task-c', workerId: null, outcome: 'crashed', exitCode: null, crash: 'no_worker_id' }),
  ], parseMetricsResponse(METRICS_RESPONSE), []);

  test('CSV: header plus one row per run, escaped', () => {
    const csv = toCsv(rows).trimEnd().split('\n');
    expect(csv[0]).toBe(CSV_COLUMNS.join(','));
    expect(csv).toHaveLength(4);
    const header = csv[0]!.split(',');
    const first = csv[1]!.split(',');
    expect(first[header.indexOf('task_id')]).toBe('task-a');
    expect(first[header.indexOf('clone_ms')]).toBe('1000');
    expect(first[header.indexOf('vcpu_seconds_active')]).toBe('30');
    expect(first[header.indexOf('dispatch_received_at')]).toBe('2026-09-01T10:00:00.000Z');
    expect(toCsv(joinRuns([{ ...report(), taskId: 'a,"b' }], [], [])).split('\n')[1]).toStartWith('"a,""b"');
  });

  test('summary: phase percentiles, outcomes by cause, resources, prices', () => {
    const md = summaryMarkdown(rows, { workspace: 'ws', since: 's', until: 'u' }, ['one warning']);
    expect(md).toContain('| clone | 3 | 1.0 s | 2.6 s |');
    expect(md).toContain('| done (exit 0) | 1 |');
    expect(md).toContain('| failed (exit 1) | 1 |');
    expect(md).toContain('| crashed (exit none), crash report no_worker_id | 1 |');
    expect(md).toContain('| active vCPU-seconds | 30.0 | 30.0 | 30.0 |');
    expect(md).toContain('$0.0000025/GiB-s');
    expect(md).toContain('| model | 12 | 12000 |');
    expect(md).toContain('- one warning');
  });

  test('causeOf', () => {
    expect(causeOf(report())).toBe('done (exit 0)');
  });
});

describe('args and window', () => {
  test('parseEvalArgs', () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    expect(parseEvalArgs(['--workspace', 'ws-1', '--since', '2026-09-01'], now)).toEqual({
      workspace: 'ws-1', since: '2026-09-01T00:00:00.000Z', until: '2026-09-30T00:00:00.000Z', out: null,
    });
    expect(parseEvalArgs(['--workspace=ws-1', '--since=2026-09-01T00:00:00Z', '--until', '2026-09-02T00:00:00Z', '--out', 'x'], now)).toMatchObject({ until: '2026-09-02T00:00:00.000Z', out: 'x' });
    expect(parseEvalArgs(['--since', '2026-09-01'], now)).toEqual({ error: '--workspace <id> is required' });
    expect(parseEvalArgs(['--workspace', 'w', '--since', 'soon'], now)).toHaveProperty('error');
    expect(parseEvalArgs(['--workspace', 'w', '--since', '2026-09-02', '--until', '2026-09-01'], now)).toHaveProperty('error');
  });

  test('analyticsWindow spans first dispatch to last exit, with slack', () => {
    const w = analyticsWindow([report({ start: T0, durS: 60 }), report({ start: T0 + 600_000, durS: 60 })], 0, 1);
    expect(w).toEqual({ start: T0 - 120_000, end: T0 + 660_000 + 120_000 });
    expect(analyticsWindow([], 5, 9)).toEqual({ start: 5, end: 9 });
  });
});
