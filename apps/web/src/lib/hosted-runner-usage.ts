/**
 * Hosted (cloud) runner time: the monthly roll-up, the month-end forecast and
 * the allowance thresholds.
 *
 * Counted time is wall time on the hosted runner weighted by container size
 * (`RUNNER_SIZE_WEIGHT`: standard 1x, large 2x), as each cloud run report
 * records it (`runnerSize.weightedRunnerSeconds`). One `runner_usage` row per
 * attempt; an attempt that spans a month boundary is split between the two
 * months by the share of its running time on each side.
 *
 * Pure: rows come in, numbers go out. hosted-runner-usage-store.ts does the
 * reading and writing.
 */
import {
  RUNNER_SIZE_WEIGHT,
  isRunnerSize,
  monthlyWindowStart,
  nextMonthlyReset,
  type RunnerSize,
} from '@buildd/shared';

/** At this share of the allowance Home shows a banner. */
export const HOSTED_RUNNER_WARN_RATIO = 0.8;
/** No forecast before this much of the month has passed: one busy morning is not a pace. */
export const FORECAST_MIN_ELAPSED_MS = 24 * 3600 * 1000;

export interface RunnerUsageRow {
  workspaceId: string;
  taskId: string | null;
  size: RunnerSize;
  runnerSeconds: number;
  weightedRunnerSeconds: number;
  /** Container running. */
  startedAt: Date;
  /** Runner exit. */
  endedAt: Date;
}

/** What one run report contributes: its attempt's class, seconds and window. */
export interface RunnerUsageFromReport {
  attempt: number;
  size: RunnerSize;
  runnerSeconds: number;
  weightedRunnerSeconds: number;
  startedAt: Date;
  endedAt: Date;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
const nonNeg = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The usage row a cloud run report carries, or null when it carries none (the
 * container never ran, or the value is not a report). An unknown size reads
 * as standard, so a malformed report never counts more than 1x.
 */
export function runnerUsageFromReport(report: unknown): RunnerUsageFromReport | null {
  const r = obj(report);
  const attempt = nonNeg(r.attempt);
  if (attempt === null || !Number.isInteger(attempt)) return null;
  const ts = obj(r.timestamps);
  const from = nonNeg(ts.containerRunningAt);
  const to = nonNeg(ts.exitedAt);
  if (from === null || to === null || to < from) return null;
  const rs = obj(r.runnerSize);
  const size: RunnerSize = isRunnerSize(rs.size) ? rs.size : 'standard';
  const seconds = nonNeg(rs.runnerSeconds);
  if (seconds === null) return null;
  const runnerSeconds = Math.round(seconds);
  const reported = nonNeg(rs.weightedRunnerSeconds);
  const weighted = reported !== null && isRunnerSize(rs.size) ? Math.round(reported) : runnerSeconds * RUNNER_SIZE_WEIGHT[size];
  return { attempt, size, runnerSeconds, weightedRunnerSeconds: weighted, startedAt: new Date(from), endedAt: new Date(to) };
}

/**
 * The part of one attempt that falls inside [start, end): all of it when it
 * ran wholly inside, else its seconds scaled by the share of its running time
 * inside the window.
 */
export function clipRunnerUsage(row: RunnerUsageRow, start: Date, end: Date): { wallSeconds: number; countedSeconds: number } {
  const a = row.startedAt.getTime();
  const b = row.endedAt.getTime();
  const s = start.getTime();
  const e = end.getTime();
  if (a >= s && b <= e && a < e) return { wallSeconds: row.runnerSeconds, countedSeconds: row.weightedRunnerSeconds };
  const overlap = Math.min(b, e) - Math.max(a, s);
  if (overlap <= 0 || b <= a) return { wallSeconds: 0, countedSeconds: 0 };
  const share = overlap / (b - a);
  return {
    wallSeconds: Math.round(row.runnerSeconds * share),
    countedSeconds: Math.round(row.weightedRunnerSeconds * share),
  };
}

export interface SizeTotals { runs: number; wallSeconds: number; countedSeconds: number }
export type SizeMix = Record<RunnerSize, SizeTotals>;
/** A workspace's size over the month: one class, or both. */
export type UsageSize = RunnerSize | 'mixed';

export interface WorkspaceRunnerUsage {
  workspaceId: string;
  tasks: number;
  runs: number;
  wallSeconds: number;
  countedSeconds: number;
  mix: SizeMix;
  size: UsageSize;
}

export interface HostedRunnerRollup {
  windowStart: Date;
  windowEnd: Date;
  tasks: number;
  runs: number;
  wallSeconds: number;
  countedSeconds: number;
  mix: SizeMix;
  /** Most counted time first. */
  workspaces: WorkspaceRunnerUsage[];
}

const emptyMix = (): SizeMix => ({
  standard: { runs: 0, wallSeconds: 0, countedSeconds: 0 },
  large: { runs: 0, wallSeconds: 0, countedSeconds: 0 },
});

function sizeOf(mix: SizeMix): UsageSize {
  if (mix.large.runs > 0 && mix.standard.runs > 0) return 'mixed';
  return mix.large.runs > 0 ? 'large' : 'standard';
}

/** The current UTC month's hosted runner time, in total and per workspace. */
export function rollUpRunnerUsage(rows: RunnerUsageRow[], now: Date): HostedRunnerRollup {
  const windowStart = monthlyWindowStart(now);
  const windowEnd = nextMonthlyReset(now);
  const mix = emptyMix();
  const tasks = new Set<string>();
  const byWs = new Map<string, { tasks: Set<string>; runs: number; wallSeconds: number; countedSeconds: number; mix: SizeMix }>();
  let runs = 0, wallSeconds = 0, countedSeconds = 0;

  for (const row of rows) {
    const part = clipRunnerUsage(row, windowStart, windowEnd);
    const inside = row.startedAt < windowEnd && row.endedAt >= windowStart;
    if (!inside) continue;
    runs += 1;
    wallSeconds += part.wallSeconds;
    countedSeconds += part.countedSeconds;
    const m = mix[row.size];
    m.runs += 1; m.wallSeconds += part.wallSeconds; m.countedSeconds += part.countedSeconds;
    if (row.taskId) tasks.add(row.taskId);

    let ws = byWs.get(row.workspaceId);
    if (!ws) { ws = { tasks: new Set(), runs: 0, wallSeconds: 0, countedSeconds: 0, mix: emptyMix() }; byWs.set(row.workspaceId, ws); }
    ws.runs += 1; ws.wallSeconds += part.wallSeconds; ws.countedSeconds += part.countedSeconds;
    const wm = ws.mix[row.size];
    wm.runs += 1; wm.wallSeconds += part.wallSeconds; wm.countedSeconds += part.countedSeconds;
    if (row.taskId) ws.tasks.add(row.taskId);
  }

  const workspaces: WorkspaceRunnerUsage[] = [...byWs.entries()]
    .map(([workspaceId, w]) => ({
      workspaceId,
      tasks: w.tasks.size,
      runs: w.runs,
      wallSeconds: w.wallSeconds,
      countedSeconds: w.countedSeconds,
      mix: w.mix,
      size: sizeOf(w.mix),
    }))
    .sort((a, b) => b.countedSeconds - a.countedSeconds || b.wallSeconds - a.wallSeconds);

  return { windowStart, windowEnd, tasks: tasks.size, runs, wallSeconds, countedSeconds, mix, workspaces };
}

/**
 * Counted time by the end of the month at the pace so far. Null in the
 * month's first day: too little to go on.
 */
export function forecastMonthEnd(countedSeconds: number, now: Date): { projectedSeconds: number } | null {
  const start = monthlyWindowStart(now).getTime();
  const end = nextMonthlyReset(now).getTime();
  const elapsed = now.getTime() - start;
  if (elapsed < FORECAST_MIN_ELAPSED_MS) return null;
  return { projectedSeconds: Math.round(countedSeconds * ((end - start) / elapsed)) };
}

export type AllowanceLevel = 'none' | 'under' | 'warn' | 'used';

/**
 * Where counted time stands against the allowance. `warn` from 80% (Home
 * banner); `used` from 100% (new cloud runs wait). `none` without an allowance.
 */
export function allowanceLevel(countedSeconds: number, allowanceHours: number | null): AllowanceLevel {
  if (allowanceHours === null) return 'none';
  const hours = countedSeconds / 3600;
  if (hours >= allowanceHours) return 'used';
  if (hours >= allowanceHours * HOSTED_RUNNER_WARN_RATIO) return 'warn';
  return 'under';
}

/** "32.4", "50": hours to at most one decimal. */
export function formatRunnerHours(seconds: number): string {
  const h = Math.round((seconds / 3600) * 10) / 10;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

/** "19 min", "1 h 5 min", "2 h". Anything under a minute reads as 1 min. */
export function formatRunnerDuration(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const SIZE_WORDS: Record<UsageSize, string> = { standard: 'standard', large: 'large', mixed: 'standard and large' };

/** The one line on a cloud task's detail page. */
export function taskRunnerLine(u: { size: UsageSize; wallSeconds: number; countedSeconds: number }): string {
  const base = `Ran on the hosted runner · ${SIZE_WORDS[u.size]} · ${formatRunnerDuration(u.wallSeconds)}`;
  return u.countedSeconds > u.wallSeconds ? `${base} (counts ${formatRunnerDuration(u.countedSeconds)})` : base;
}

/** A task's own hosted runner time, all attempts, any month. Null when it never ran there. */
export function taskRunnerUsage(rows: RunnerUsageRow[]): { size: UsageSize; wallSeconds: number; countedSeconds: number } | null {
  if (rows.length === 0) return null;
  const mix = emptyMix();
  let wallSeconds = 0, countedSeconds = 0;
  for (const r of rows) {
    mix[r.size].runs += 1;
    wallSeconds += r.runnerSeconds;
    countedSeconds += r.weightedRunnerSeconds;
  }
  return { size: sizeOf(mix), wallSeconds, countedSeconds };
}

export interface HostedRunnerMeterView {
  /** "32.4 of 50 runner-hours", or "32.4 runner-hours" without an allowance. */
  headline: string;
  /** 0–100 fill of the meter; null without an allowance (no meter drawn). */
  percent: number | null;
  level: AllowanceLevel;
  /** "On pace for 41 h by month end", plus when the pace crosses the allowance. Null early in the month. */
  forecast: string | null;
}

const shortDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The usage page's meter and forecast line. */
export function hostedRunnerMeterView(
  s: { allowanceHours: number | null; countedSeconds: number; forecast: { projectedSeconds: number } | null },
  now: Date,
): HostedRunnerMeterView {
  const used = formatRunnerHours(s.countedSeconds);
  const level = allowanceLevel(s.countedSeconds, s.allowanceHours);
  const headline = s.allowanceHours === null ? `${used} runner-hours` : `${used} of ${s.allowanceHours} runner-hours`;
  const percent = s.allowanceHours === null
    ? null
    : s.allowanceHours === 0 ? 100 : Math.min(100, Math.round((s.countedSeconds / 3600 / s.allowanceHours) * 1000) / 10);

  let forecast: string | null = null;
  if (s.forecast && s.countedSeconds > 0) {
    forecast = `On pace for ${formatRunnerHours(s.forecast.projectedSeconds)} h by month end`;
    const limitSeconds = s.allowanceHours === null ? null : s.allowanceHours * 3600;
    if (limitSeconds !== null && level !== 'used' && s.forecast.projectedSeconds > limitSeconds && s.countedSeconds > 0) {
      const start = monthlyWindowStart(now).getTime();
      const pacePerMs = s.countedSeconds / (now.getTime() - start);
      const at = new Date(start + limitSeconds / pacePerMs);
      forecast += `, reaching ${s.allowanceHours} h around ${shortDate(at)}`;
    }
    forecast += '.';
  }
  return { headline, percent, level, forecast };
}

/** Home banner copy at 80% and 100%; null below that or without an allowance. */
export function hostedRunnerBannerText(s: { allowanceHours: number | null; countedSeconds: number }, now: Date): { level: 'warn' | 'used'; text: string } | null {
  const level = allowanceLevel(s.countedSeconds, s.allowanceHours);
  if (level !== 'warn' && level !== 'used') return null;
  if (level === 'used') {
    return { level, text: `Hosted runner allowance used. New cloud runs wait until hours refill on ${shortDate(nextMonthlyReset(now))}.` };
  }
  return { level, text: `Hosted runner: ${formatRunnerHours(s.countedSeconds)} of ${s.allowanceHours} hours used this month.` };
}

/** Workspace settings: "This month: 9.1 h on the runner, counted as 18.2 h". */
export function workspaceRunnerMonthLine(m: { wallSeconds: number; countedSeconds: number }): string {
  const wall = `This month: ${formatRunnerHours(m.wallSeconds)} h on the runner`;
  return m.countedSeconds !== m.wallSeconds ? `${wall}, counted as ${formatRunnerHours(m.countedSeconds)} h` : wall;
}
