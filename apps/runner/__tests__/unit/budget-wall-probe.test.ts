import { describe, test, expect } from 'bun:test';
import { BudgetWallProber, classifyBudgetProbe, budgetProbeIntervalMs, describeBudgetProbeRun } from '../../src/budget-wall-probe';

const LIMIT = "You've hit your weekly limit · resets Oct 30, 9am (UTC)";

function make(probeResult: { ok: boolean; error?: string }, opts: { now?: () => number } = {}) {
  const reports: any[] = [];
  let cleared = 0;
  const prober = new BudgetWallProber({
    probe: async () => probeResult,
    report: async (r) => { reports.push(r); },
    onCleared: () => { cleared++; },
    intervalMs: 20 * 60_000,
    now: opts.now,
  });
  return { prober, reports, cleared: () => cleared };
}

describe('classifyBudgetProbe', () => {
  test('success is capacity', () => {
    expect(classifyBudgetProbe({ ok: true }).outcome).toBe('capacity');
  });
  test('a limit error is limited and carries the quoted reset', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const c = classifyBudgetProbe({ ok: false, error: LIMIT }, now);
    expect(c.outcome).toBe('limited');
    expect(c.resetsAt?.toISOString()).toBe('2026-10-30T09:00:00.000Z');
  });
  test('any other failure is error, never limited', () => {
    expect(classifyBudgetProbe({ ok: false, error: 'ECONNRESET' }).outcome).toBe('error');
  });
});

describe('BudgetWallProber', () => {
  test('probe passes: reports capacity, drops the wall, claims again', async () => {
    const { prober, reports, cleared } = make({ ok: true });
    prober.noteWall(new Date(Date.now() + 3600_000));
    const run = await prober.probeNow('cli');
    expect(run?.cleared).toBe(true);
    expect(reports[0]).toMatchObject({ outcome: 'capacity', trigger: 'cli' });
    expect(prober.wallResetsAt).toBeNull();
    expect(cleared()).toBe(1);
    expect(describeBudgetProbeRun(run)).toContain('cleared');
  });

  test('probe hits the limit: keeps the wall and refreshes the reset time', async () => {
    const { prober, reports, cleared } = make({ ok: false, error: LIMIT });
    prober.noteWall(new Date(Date.now() + 3600_000));
    const run = await prober.probeNow('cli');
    expect(run?.cleared).toBe(false);
    expect(reports[0].outcome).toBe('limited');
    expect(reports[0].resetsAt).toBe('2026-10-30T09:00:00.000Z');
    expect(prober.wallResetsAt?.toISOString()).toBe('2026-10-30T09:00:00.000Z');
    expect(cleared()).toBe(0);
  });

  test('the wall goes back up after a premature clear when the next claim reports it', async () => {
    const { prober } = make({ ok: true });
    prober.noteWall(new Date(Date.now() + 3600_000));
    await prober.probeNow('auto');
    expect(prober.wallResetsAt).toBeNull();
    prober.noteWall(new Date(Date.now() + 7200_000)); // real limit error -> claim reports the wall again
    expect(prober.wallResetsAt).not.toBeNull();
  });

  test('a report the server never heard keeps the wall', async () => {
    const prober = new BudgetWallProber({
      probe: async () => ({ ok: true }),
      report: async () => { throw new Error('offline'); },
      onCleared: () => { throw new Error('must not clear'); },
    });
    prober.noteWall(new Date(Date.now() + 3600_000));
    const run = await prober.probeNow('auto');
    expect(run?.cleared).toBe(false);
    expect(prober.wallResetsAt).not.toBeNull();
  });

  test('interval: probes only while a wall is up, once per interval', async () => {
    let t = 100_000_000;
    const { prober, reports } = make({ ok: false, error: 'overloaded' }, { now: () => t });
    expect(await prober.tick()).toBeNull(); // no wall
    prober.noteWall(new Date(t + 10 * 3600_000));
    expect(await prober.tick()).not.toBeNull();
    t += 5 * 60_000;
    expect(await prober.tick()).toBeNull(); // inside the interval
    t += 20 * 60_000;
    expect(await prober.tick()).not.toBeNull();
    expect(reports).toHaveLength(2);
  });

  test('a nudge probes once per new request value', async () => {
    const { prober, reports } = make({ ok: false, error: 'overloaded' });
    expect(await prober.noteNudge(null)).toBeNull();
    expect(await prober.noteNudge('2026-10-22T10:00:00Z')).not.toBeNull();
    expect(await prober.noteNudge('2026-10-22T10:00:00Z')).toBeNull();
    expect(reports[0].trigger).toBe('nudge');
  });

  test('interval env: default, override, 0 disables', () => {
    expect(budgetProbeIntervalMs({})).toBe(20 * 60_000);
    expect(budgetProbeIntervalMs({ BUILDD_BUDGET_PROBE_INTERVAL_MIN: '30' })).toBe(30 * 60_000);
    expect(budgetProbeIntervalMs({ BUILDD_BUDGET_PROBE_INTERVAL_MIN: '0' })).toBe(0);
  });
});
