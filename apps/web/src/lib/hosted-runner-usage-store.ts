/**
 * The I/O around lib/hosted-runner-usage.ts: record an attempt's hosted runner
 * time when its run report arrives, read a team's month in one query, and the
 * claim-time allowance check.
 *
 * The allowance is `teams.hostedRunnerHours` (counted hours per UTC month).
 * NULL, the default, is no cap: the check returns without reading usage.
 */
import { db } from '@buildd/core/db';
import { runnerUsage, teams, workspaces } from '@buildd/core/db/schema';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import {
  evaluateHostedRunnerAllowance,
  isRunnerSize,
  monthlyWindowStart,
  nextMonthlyReset,
  type EntitlementBlock,
} from '@buildd/shared';
import {
  allowanceLevel,
  forecastMonthEnd,
  hostedRunnerBannerText,
  rollUpRunnerUsage,
  runnerUsageFromReport,
  taskRunnerUsage,
  type AllowanceLevel,
  type HostedRunnerRollup,
  type RunnerUsageRow,
  type UsageSize,
} from './hosted-runner-usage';
import { RUN_REPORT_KEY_PREFIX } from './runner-size-store';

/** True for the artifact key a cloud run report is delivered under. */
export function isRunReportKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(`${RUN_REPORT_KEY_PREFIX}:`);
}

/**
 * Keep one attempt's hosted runner time. Idempotent per (worker, attempt): a
 * re-delivered report overwrites its own row, and a resumed attempt adds one.
 * Best-effort; a report without runner time (the container never ran) writes
 * nothing.
 */
export async function recordRunnerUsageFromReport(input: {
  workspaceId: string;
  workerId: string;
  taskId: string | null;
  report: unknown;
}): Promise<boolean> {
  const u = runnerUsageFromReport(input.report);
  if (!u) return false;
  try {
    await db.insert(runnerUsage)
      .values({
        workspaceId: input.workspaceId,
        workerId: input.workerId,
        taskId: input.taskId,
        attempt: u.attempt,
        size: u.size,
        runnerSeconds: u.runnerSeconds,
        weightedRunnerSeconds: u.weightedRunnerSeconds,
        startedAt: u.startedAt,
        endedAt: u.endedAt,
      })
      .onConflictDoUpdate({
        target: [runnerUsage.workerId, runnerUsage.attempt],
        set: {
          size: u.size,
          runnerSeconds: u.runnerSeconds,
          weightedRunnerSeconds: u.weightedRunnerSeconds,
          startedAt: u.startedAt,
          endedAt: u.endedAt,
        },
      });
    return true;
  } catch (err) {
    console.error(`[hosted-runner] recording usage for worker ${input.workerId} failed:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

const toRow = (r: { workspaceId: string; taskId: string | null; size: string; runnerSeconds: number; weightedRunnerSeconds: number; startedAt: Date; endedAt: Date }): RunnerUsageRow => ({
  workspaceId: r.workspaceId,
  taskId: r.taskId,
  size: isRunnerSize(r.size) ? r.size : 'standard',
  runnerSeconds: r.runnerSeconds,
  weightedRunnerSeconds: r.weightedRunnerSeconds,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
});

const rowColumns = {
  workspaceId: runnerUsage.workspaceId,
  taskId: runnerUsage.taskId,
  size: runnerUsage.size,
  runnerSeconds: runnerUsage.runnerSeconds,
  weightedRunnerSeconds: runnerUsage.weightedRunnerSeconds,
  startedAt: runnerUsage.startedAt,
  endedAt: runnerUsage.endedAt,
};

export interface HostedRunnerDeps {
  loadAllowanceHours(teamId: string): Promise<number | null>;
  /** Every attempt of the team's workspaces that overlaps [start, end). One query. */
  loadTeamRows(teamId: string, start: Date, end: Date): Promise<RunnerUsageRow[]>;
}

export const dbHostedRunnerDeps: HostedRunnerDeps = {
  async loadAllowanceHours(teamId) {
    const row = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { hostedRunnerHours: true } });
    const v = row?.hostedRunnerHours;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  },
  async loadTeamRows(teamId, start, end) {
    const rows = await db.select(rowColumns)
      .from(runnerUsage)
      .innerJoin(workspaces, eq(workspaces.id, runnerUsage.workspaceId))
      .where(and(eq(workspaces.teamId, teamId), gte(runnerUsage.endedAt, start), lt(runnerUsage.startedAt, end)));
    return rows.map(toRow);
  },
};

export interface HostedRunnerSummary {
  allowanceHours: number | null;
  rollup: HostedRunnerRollup;
  level: AllowanceLevel;
  forecast: { projectedSeconds: number } | null;
}

/** The team's month on the hosted runner, against its allowance. */
export async function teamHostedRunnerSummary(teamId: string, now = new Date(), deps: HostedRunnerDeps = dbHostedRunnerDeps): Promise<HostedRunnerSummary> {
  const [allowanceHours, rows] = await Promise.all([
    deps.loadAllowanceHours(teamId),
    deps.loadTeamRows(teamId, monthlyWindowStart(now), nextMonthlyReset(now)),
  ]);
  const rollup = rollUpRunnerUsage(rows, now);
  return {
    allowanceHours,
    rollup,
    level: allowanceLevel(rollup.countedSeconds, allowanceHours),
    forecast: forecastMonthEnd(rollup.countedSeconds, now),
  };
}

/**
 * May one more hosted (cloud) run start for this team? Null = yes. Without an
 * allowance, no usage is read. Running tasks are never touched: this is only
 * asked at claim time.
 */
export async function checkHostedRunnerAllowance(
  teamId: string,
  opts: { now?: Date } = {},
  deps: HostedRunnerDeps = dbHostedRunnerDeps,
): Promise<EntitlementBlock | null> {
  const allowance = await deps.loadAllowanceHours(teamId);
  if (allowance === null) return null;
  const now = opts.now ?? new Date();
  const rows = await deps.loadTeamRows(teamId, monthlyWindowStart(now), nextMonthlyReset(now));
  return evaluateHostedRunnerAllowance(allowance, rollUpRunnerUsage(rows, now).countedSeconds / 3600, now);
}

/**
 * Home's banner at 80% and 100% of the allowance, or null. A team without an
 * allowance costs one key lookup and reads no usage.
 */
export async function teamHostedRunnerBanner(teamId: string, now = new Date(), deps: HostedRunnerDeps = dbHostedRunnerDeps): Promise<{ level: 'warn' | 'used'; text: string } | null> {
  const allowanceHours = await deps.loadAllowanceHours(teamId);
  if (allowanceHours === null) return null;
  const rows = await deps.loadTeamRows(teamId, monthlyWindowStart(now), nextMonthlyReset(now));
  return hostedRunnerBannerText({ allowanceHours, countedSeconds: rollUpRunnerUsage(rows, now).countedSeconds }, now);
}

/** One workspace's month on the hosted runner (workspace settings). */
export async function workspaceHostedRunnerMonth(workspaceId: string, now = new Date()): Promise<{ wallSeconds: number; countedSeconds: number }> {
  const start = monthlyWindowStart(now);
  const end = nextMonthlyReset(now);
  const rows = await db.select(rowColumns)
    .from(runnerUsage)
    .where(and(eq(runnerUsage.workspaceId, workspaceId), gte(runnerUsage.endedAt, start), lt(runnerUsage.startedAt, end)));
  const r = rollUpRunnerUsage(rows.map(toRow), now);
  return { wallSeconds: r.wallSeconds, countedSeconds: r.countedSeconds };
}

/** A task's hosted runner time over all its attempts, or null when it never ran there. */
export async function taskHostedRunnerUsage(taskId: string): Promise<{ size: UsageSize; wallSeconds: number; countedSeconds: number } | null> {
  const rows = await db.select(rowColumns).from(runnerUsage).where(eq(runnerUsage.taskId, taskId));
  return taskRunnerUsage(rows.map(toRow));
}

/** Names of the workspaces in a roll-up, for the usage table. */
export async function workspaceNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(inArray(workspaces.id, ids));
  return new Map(rows.map(r => [r.id, r.name]));
}

export type { AllowanceLevel, HostedRunnerRollup };
