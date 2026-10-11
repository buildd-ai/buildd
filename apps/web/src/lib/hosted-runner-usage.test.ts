import { describe, it, expect } from 'bun:test';
import { evaluateHostedRunnerAllowance, parseEntitlementBlock, entitlementDeferralKey } from '@buildd/shared';
import {
  HOSTED_RUNNER_WARN_RATIO,
  allowanceLevel,
  clipRunnerUsage,
  forecastMonthEnd,
  formatRunnerDuration,
  formatRunnerHours,
  rollUpRunnerUsage,
  runnerUsageFromReport,
  taskRunnerLine,
  taskRunnerUsage,
  hostedRunnerMeterView,
  hostedRunnerBannerText,
  workspaceRunnerMonthLine,
  type RunnerUsageRow,
} from './hosted-runner-usage';

const NOW = new Date('2026-10-16T00:00:00Z'); // exactly half of October (31 days → 15 elapsed)
const T = (iso: string) => new Date(iso);

function row(o: Partial<RunnerUsageRow> & { startedAt: Date; endedAt: Date }): RunnerUsageRow {
  const seconds = Math.ceil((o.endedAt.getTime() - o.startedAt.getTime()) / 1000);
  const size = o.size ?? 'standard';
  return {
    workspaceId: o.workspaceId ?? 'ws-a',
    taskId: o.taskId === undefined ? 'task-1' : o.taskId,
    size,
    runnerSeconds: o.runnerSeconds ?? seconds,
    weightedRunnerSeconds: o.weightedRunnerSeconds ?? seconds * (size === 'large' ? 2 : 1),
    startedAt: o.startedAt,
    endedAt: o.endedAt,
  };
}

describe('runnerUsageFromReport', () => {
  const report = {
    kind: 'cloud-run-report',
    taskId: 'task-1',
    attempt: 2,
    timestamps: { containerRunningAt: Date.parse('2026-10-05T10:00:00Z'), exitedAt: Date.parse('2026-10-05T10:19:00Z') },
    runnerSize: { size: 'large', weight: 2, runnerSeconds: 1140, weightedRunnerSeconds: 2280 },
  };

  it('reads the class, the seconds and the running-to-exit window of one attempt', () => {
    expect(runnerUsageFromReport(report)).toEqual({
      attempt: 2,
      size: 'large',
      runnerSeconds: 1140,
      weightedRunnerSeconds: 2280,
      startedAt: T('2026-10-05T10:00:00Z'),
      endedAt: T('2026-10-05T10:19:00Z'),
    });
  });

  it('weights by class itself when an older report has no weighted figure', () => {
    const r = { ...report, runnerSize: { size: 'large', runnerSeconds: 100, weightedRunnerSeconds: null } };
    expect(runnerUsageFromReport(r)?.weightedRunnerSeconds).toBe(200);
  });

  it('is null when the container never ran, or the report is not one', () => {
    expect(runnerUsageFromReport({ ...report, runnerSize: { size: 'standard', runnerSeconds: null, weightedRunnerSeconds: null } })).toBeNull();
    expect(runnerUsageFromReport({ ...report, timestamps: { containerRunningAt: null, exitedAt: null } })).toBeNull();
    expect(runnerUsageFromReport(null)).toBeNull();
    expect(runnerUsageFromReport('nope')).toBeNull();
    expect(runnerUsageFromReport({ ...report, attempt: -1 })).toBeNull();
  });

  it('treats an unknown size as standard (the class weight never exceeds what ran)', () => {
    const r = { ...report, runnerSize: { size: 'huge', runnerSeconds: 60, weightedRunnerSeconds: null } };
    expect(runnerUsageFromReport(r)).toMatchObject({ size: 'standard', weightedRunnerSeconds: 60 });
  });
});

describe('clipRunnerUsage (month boundaries)', () => {
  const start = T('2026-10-01T00:00:00Z');
  const end = T('2026-11-01T00:00:00Z');

  it('an attempt inside the month counts whole, exactly as reported', () => {
    const r = row({ startedAt: T('2026-10-05T10:00:00Z'), endedAt: T('2026-10-05T10:19:00Z'), size: 'large' });
    expect(clipRunnerUsage(r, start, end)).toEqual({ wallSeconds: 1140, countedSeconds: 2280 });
  });

  it('an attempt across the month start counts only its share inside the month', () => {
    // 23:30 Sep 30 → 00:30 Oct 1: half in each month.
    const r = row({ startedAt: T('2026-09-30T23:30:00Z'), endedAt: T('2026-10-01T00:30:00Z'), size: 'large' });
    expect(clipRunnerUsage(r, start, end)).toEqual({ wallSeconds: 1800, countedSeconds: 3600 });
    expect(clipRunnerUsage(r, T('2026-09-01T00:00:00Z'), start)).toEqual({ wallSeconds: 1800, countedSeconds: 3600 });
  });

  it('an attempt across the month end is split the same way', () => {
    const r = row({ startedAt: T('2026-10-31T23:45:00Z'), endedAt: T('2026-11-01T00:15:00Z') });
    expect(clipRunnerUsage(r, start, end)).toEqual({ wallSeconds: 900, countedSeconds: 900 });
  });

  it('an attempt wholly outside the month counts nothing', () => {
    const r = row({ startedAt: T('2026-09-10T00:00:00Z'), endedAt: T('2026-09-10T01:00:00Z') });
    expect(clipRunnerUsage(r, start, end)).toEqual({ wallSeconds: 0, countedSeconds: 0 });
  });

  it('a zero-length attempt counts where it happened', () => {
    const r = row({ startedAt: T('2026-10-02T00:00:00Z'), endedAt: T('2026-10-02T00:00:00Z'), runnerSeconds: 0, weightedRunnerSeconds: 0 });
    expect(clipRunnerUsage(r, start, end)).toEqual({ wallSeconds: 0, countedSeconds: 0 });
  });
});

describe('rollUpRunnerUsage', () => {
  const rows: RunnerUsageRow[] = [
    // ws-a: one large task (two attempts), one standard task.
    row({ workspaceId: 'ws-a', taskId: 't1', size: 'large', startedAt: T('2026-10-02T10:00:00Z'), endedAt: T('2026-10-02T11:00:00Z') }),
    row({ workspaceId: 'ws-a', taskId: 't1', size: 'large', startedAt: T('2026-10-02T12:00:00Z'), endedAt: T('2026-10-02T12:30:00Z') }),
    row({ workspaceId: 'ws-a', taskId: 't2', size: 'standard', startedAt: T('2026-10-03T10:00:00Z'), endedAt: T('2026-10-03T11:00:00Z') }),
    // ws-b: two standard hours, more wall but fewer counted hours than ws-a.
    row({ workspaceId: 'ws-b', taskId: 't3', size: 'standard', startedAt: T('2026-10-04T10:00:00Z'), endedAt: T('2026-10-04T12:00:00Z') }),
    // Last month: never counted.
    row({ workspaceId: 'ws-b', taskId: 't4', size: 'large', startedAt: T('2026-09-20T10:00:00Z'), endedAt: T('2026-09-20T12:00:00Z') }),
  ];

  const r = rollUpRunnerUsage(rows, NOW);

  it('totals wall and counted time for the current UTC month only', () => {
    expect(r.windowStart).toEqual(T('2026-10-01T00:00:00Z'));
    expect(r.windowEnd).toEqual(T('2026-11-01T00:00:00Z'));
    expect(r.wallSeconds).toBe((60 + 30 + 60 + 120) * 60);
    expect(r.countedSeconds).toBe((120 + 60 + 60 + 120) * 60);
    expect(r.tasks).toBe(3);
    expect(r.runs).toBe(4);
  });

  it('keeps the size mix: large counts 2x, standard 1x', () => {
    expect(r.mix.large).toEqual({ runs: 2, wallSeconds: 90 * 60, countedSeconds: 180 * 60 });
    expect(r.mix.standard).toEqual({ runs: 2, wallSeconds: 180 * 60, countedSeconds: 180 * 60 });
  });

  it('one row per workspace, sorted by counted hours, with its tasks and size', () => {
    expect(r.workspaces.map(w => w.workspaceId)).toEqual(['ws-a', 'ws-b']);
    expect(r.workspaces[0]).toMatchObject({ tasks: 2, runs: 3, wallSeconds: 150 * 60, countedSeconds: 240 * 60, size: 'mixed' });
    expect(r.workspaces[1]).toMatchObject({ tasks: 1, runs: 1, wallSeconds: 120 * 60, countedSeconds: 120 * 60, size: 'standard' });
  });

  it('is empty, not missing, with no runs', () => {
    const empty = rollUpRunnerUsage([], NOW);
    expect(empty).toMatchObject({ wallSeconds: 0, countedSeconds: 0, tasks: 0, runs: 0, workspaces: [] });
  });

  it('a workspace whose runs all fell last month does not appear', () => {
    const only = rollUpRunnerUsage([rows[4]], NOW);
    expect(only.workspaces).toEqual([]);
  });
});

describe('forecastMonthEnd', () => {
  it('projects the month at the pace so far', () => {
    // 15 of 31 days elapsed, 15 counted hours → 31 hours by month end.
    const f = forecastMonthEnd(15 * 3600, NOW);
    expect(f).not.toBeNull();
    expect(f!.projectedSeconds).toBe(31 * 3600);
  });

  it('says nothing in the first day of the month (too little to go on)', () => {
    expect(forecastMonthEnd(3600, T('2026-10-01T20:00:00Z'))).toBeNull();
  });

  it('zero use projects zero', () => {
    expect(forecastMonthEnd(0, NOW)?.projectedSeconds).toBe(0);
  });
});

describe('allowanceLevel (thresholds)', () => {
  it('no allowance: no level, whatever the use', () => {
    expect(allowanceLevel(1e9, null)).toBe('none');
  });

  it(`warns at ${HOSTED_RUNNER_WARN_RATIO * 100}% and stops new cloud runs at 100%`, () => {
    expect(allowanceLevel(39.9 * 3600, 50)).toBe('under');
    expect(allowanceLevel(40 * 3600, 50)).toBe('warn');
    expect(allowanceLevel(49.9 * 3600, 50)).toBe('warn');
    expect(allowanceLevel(50 * 3600, 50)).toBe('used');
    expect(allowanceLevel(70 * 3600, 50)).toBe('used');
  });

  it('a zero allowance is used from the start', () => {
    expect(allowanceLevel(0, 0)).toBe('used');
  });
});

describe('evaluateHostedRunnerAllowance (the gate)', () => {
  it('never blocks without an allowance (today, for everyone)', () => {
    expect(evaluateHostedRunnerAllowance(null, 1e6, NOW)).toBeNull();
  });

  it('lets runs start below the allowance and holds them at it', () => {
    expect(evaluateHostedRunnerAllowance(50, 49.99, NOW)).toBeNull();
    const block = evaluateHostedRunnerAllowance(50, 50.04, NOW);
    expect(block).toEqual({
      kind: 'hosted_runner',
      key: 'hosted_runner.hours',
      unit: 'counted_runner_hours',
      used: 50,
      limit: 50,
      resetsAt: '2026-11-01T00:00:00.000Z',
    });
    expect(entitlementDeferralKey(block!)).toBe('hosted_runner_hours');
  });

  it('survives the round trip through task context', () => {
    const block = evaluateHostedRunnerAllowance(50, 51, NOW)!;
    expect(parseEntitlementBlock(JSON.parse(JSON.stringify({ ...block, at: NOW.toISOString() })))).toEqual(block);
  });
});

describe('formatting', () => {
  it('hours to one decimal', () => {
    expect(formatRunnerHours(32.4 * 3600)).toBe('32.4');
    expect(formatRunnerHours(50 * 3600)).toBe('50');
    expect(formatRunnerHours(0)).toBe('0');
  });

  it('durations in minutes, then hours and minutes', () => {
    expect(formatRunnerDuration(19 * 60)).toBe('19 min');
    expect(formatRunnerDuration(30)).toBe('1 min');
    expect(formatRunnerDuration(65 * 60)).toBe('1 h 5 min');
    expect(formatRunnerDuration(120 * 60)).toBe('2 h');
  });

  it('the task line names the size, wall time and what it counts', () => {
    expect(taskRunnerLine({ size: 'large', wallSeconds: 19 * 60, countedSeconds: 38 * 60 }))
      .toBe('Ran on the hosted runner · large · 19 min (counts 38 min)');
    expect(taskRunnerLine({ size: 'standard', wallSeconds: 19 * 60, countedSeconds: 19 * 60 }))
      .toBe('Ran on the hosted runner · standard · 19 min');
    expect(taskRunnerLine({ size: 'mixed', wallSeconds: 30 * 60, countedSeconds: 45 * 60 }))
      .toBe('Ran on the hosted runner · standard and large · 30 min (counts 45 min)');
  });
});

describe('taskRunnerUsage', () => {
  it('sums every attempt of one task, any month', () => {
    const rows = [
      row({ size: 'large', startedAt: T('2026-09-30T23:50:00Z'), endedAt: T('2026-10-01T00:00:00Z') }),
      row({ size: 'large', startedAt: T('2026-10-01T01:00:00Z'), endedAt: T('2026-10-01T01:09:00Z') }),
    ];
    expect(taskRunnerUsage(rows)).toEqual({ size: 'large', wallSeconds: 19 * 60, countedSeconds: 38 * 60 });
    expect(taskRunnerUsage([])).toBeNull();
  });
});

describe('hostedRunnerMeterView', () => {
  it('meter against the allowance, with the month-end pace', () => {
    const v = hostedRunnerMeterView({ allowanceHours: 50, countedSeconds: 32.4 * 3600, forecast: forecastMonthEnd(32.4 * 3600, NOW) }, NOW);
    expect(v.headline).toBe('32.4 of 50 runner-hours');
    expect(v.percent).toBe(64.8);
    expect(v.level).toBe('under');
    // 32.4 h in 15 days → 66.96 h by the 31st; crosses 50 h around Oct 24.
    expect(v.forecast).toBe('On pace for 67 h by month end, reaching 50 h around Oct 24.');
  });

  it('no allowance: hours only, no meter fill, plain pace', () => {
    const v = hostedRunnerMeterView({ allowanceHours: null, countedSeconds: 3 * 3600, forecast: forecastMonthEnd(3 * 3600, NOW) }, NOW);
    expect(v.headline).toBe('3 runner-hours');
    expect(v.percent).toBeNull();
    expect(v.forecast).toBe('On pace for 6.2 h by month end.');
  });

  it('past the allowance the meter is full and no crossing date is given', () => {
    const v = hostedRunnerMeterView({ allowanceHours: 50, countedSeconds: 55 * 3600, forecast: forecastMonthEnd(55 * 3600, NOW) }, NOW);
    expect(v.percent).toBe(100);
    expect(v.level).toBe('used');
    expect(v.forecast).not.toContain('reaching');
  });

  it('no pace line before anything has run', () => {
    expect(hostedRunnerMeterView({ allowanceHours: 50, countedSeconds: 0, forecast: forecastMonthEnd(0, NOW) }, NOW).forecast).toBeNull();
  });

  it('no forecast on the first day', () => {
    expect(hostedRunnerMeterView({ allowanceHours: 50, countedSeconds: 3600, forecast: null }, NOW).forecast).toBeNull();
  });
});

describe('hostedRunnerBannerText (Home)', () => {
  it('nothing below 80% or without an allowance', () => {
    expect(hostedRunnerBannerText({ allowanceHours: 50, countedSeconds: 39 * 3600 }, NOW)).toBeNull();
    expect(hostedRunnerBannerText({ allowanceHours: null, countedSeconds: 999 * 3600 }, NOW)).toBeNull();
  });

  it('at 80% a heads-up with the numbers', () => {
    expect(hostedRunnerBannerText({ allowanceHours: 50, countedSeconds: 40 * 3600 }, NOW))
      .toEqual({ level: 'warn', text: 'Hosted runner: 40 of 50 hours used this month.' });
  });

  it('at 100% says new cloud runs wait until the reset', () => {
    expect(hostedRunnerBannerText({ allowanceHours: 50, countedSeconds: 50 * 3600 }, NOW))
      .toEqual({ level: 'used', text: 'Hosted runner allowance used. New cloud runs wait until hours refill on Nov 1.' });
  });
});

describe('workspaceRunnerMonthLine', () => {
  it('wall time, and counted time when large runs doubled it', () => {
    expect(workspaceRunnerMonthLine({ wallSeconds: 9.1 * 3600, countedSeconds: 18.2 * 3600 })).toBe('This month: 9.1 h on the runner, counted as 18.2 h');
    expect(workspaceRunnerMonthLine({ wallSeconds: 2 * 3600, countedSeconds: 2 * 3600 })).toBe('This month: 2 h on the runner');
  });
});
