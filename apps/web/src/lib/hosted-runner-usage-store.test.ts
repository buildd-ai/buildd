import { describe, it, expect } from 'bun:test';
import type { RunnerUsageRow } from './hosted-runner-usage';
import { checkHostedRunnerAllowance, isRunReportKey, teamHostedRunnerBanner, teamHostedRunnerSummary, type HostedRunnerDeps } from './hosted-runner-usage-store';

const NOW = new Date('2026-10-16T00:00:00Z');

function hoursRow(hours: number, size: 'standard' | 'large' = 'standard', startIso = '2026-10-05T00:00:00Z'): RunnerUsageRow {
  const startedAt = new Date(startIso);
  const seconds = hours * 3600;
  return {
    workspaceId: 'ws-a',
    taskId: 't1',
    size,
    runnerSeconds: seconds,
    weightedRunnerSeconds: seconds * (size === 'large' ? 2 : 1),
    startedAt,
    endedAt: new Date(startedAt.getTime() + seconds * 1000),
  };
}

function deps(allowance: number | null, rows: RunnerUsageRow[]) {
  const calls = { rows: 0 };
  const d: HostedRunnerDeps = {
    loadAllowanceHours: async () => allowance,
    loadTeamRows: async () => { calls.rows++; return rows; },
  };
  return { d, calls };
}

describe('checkHostedRunnerAllowance (claim gate)', () => {
  it('no allowance: never blocks and never reads usage', async () => {
    const { d, calls } = deps(null, [hoursRow(500)]);
    expect(await checkHostedRunnerAllowance('team', { now: NOW }, d)).toBeNull();
    expect(calls.rows).toBe(0);
  });

  it('below the allowance a cloud run may start', async () => {
    const { d } = deps(50, [hoursRow(20), hoursRow(4, 'large')]); // 28 counted
    expect(await checkHostedRunnerAllowance('team', { now: NOW }, d)).toBeNull();
  });

  it('large runs count double toward it', async () => {
    const { d } = deps(50, [hoursRow(10), hoursRow(20, 'large')]); // 10 + 40 = 50 counted
    expect(await checkHostedRunnerAllowance('team', { now: NOW }, d)).toMatchObject({ kind: 'hosted_runner', used: 50, limit: 50 });
  });

  it('last month does not count against this one', async () => {
    const { d } = deps(50, [hoursRow(60, 'standard', '2026-09-02T00:00:00Z')]);
    expect(await checkHostedRunnerAllowance('team', { now: NOW }, d)).toBeNull();
  });
});

describe('teamHostedRunnerSummary', () => {
  it('reports level and forecast against the allowance', async () => {
    const { d } = deps(50, [hoursRow(42)]);
    const s = await teamHostedRunnerSummary('team', NOW, d);
    expect(s.allowanceHours).toBe(50);
    expect(s.level).toBe('warn');
    expect(s.rollup.countedSeconds).toBe(42 * 3600);
    expect(s.forecast?.projectedSeconds).toBe(Math.round(42 * 3600 * 31 / 15));
  });

  it('without an allowance there is no level, but the usage is still shown', async () => {
    const { d } = deps(null, [hoursRow(3)]);
    const s = await teamHostedRunnerSummary('team', NOW, d);
    expect(s.level).toBe('none');
    expect(s.rollup.countedSeconds).toBe(3 * 3600);
  });
});

describe('isRunReportKey', () => {
  it('matches only cloud run report keys', () => {
    expect(isRunReportKey('cloud-run-report:abc')).toBe(true);
    expect(isRunReportKey('cloud-run-reportx')).toBe(false);
    expect(isRunReportKey('summary')).toBe(false);
    expect(isRunReportKey(null)).toBe(false);
  });
});

describe('teamHostedRunnerBanner', () => {
  it('no allowance: no banner and no usage read', async () => {
    const { d, calls } = deps(null, [hoursRow(999)]);
    expect(await teamHostedRunnerBanner('team', NOW, d)).toBeNull();
    expect(calls.rows).toBe(0);
  });

  it('80% shows the heads-up, 100% says new cloud runs wait', async () => {
    expect((await teamHostedRunnerBanner('team', NOW, deps(50, [hoursRow(41)]).d))?.level).toBe('warn');
    expect((await teamHostedRunnerBanner('team', NOW, deps(50, [hoursRow(25, 'large')]).d))?.level).toBe('used');
    expect(await teamHostedRunnerBanner('team', NOW, deps(50, [hoursRow(10)]).d)).toBeNull();
  });
});
