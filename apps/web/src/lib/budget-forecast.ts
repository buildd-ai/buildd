import { db } from '@buildd/core/db';
import { teams, missions, workers, tasks, tenantBudgets, backendPauses } from '@buildd/core/db/schema';
import { and, eq, gte, inArray, isNotNull, isNull, or, desc, sql } from 'drizzle-orm';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
import { readRound } from '@/lib/read-round';

// ── Public types ──────────────────────────────────────────────────────────────

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface MonthlyBudgetForecast {
  kind: 'monthly';
  spentUsd: number;
  budgetUsd: number;
  /** 0-100 */
  pctUsed: number;
  resetsAt: string;
  burnRateUsdPerDay: number | null;
  /** null when burn rate is 0 or unknown */
  daysToDepletion: number | null;
  confidence: ConfidenceLevel;
}

export interface MissionBudgetForecast {
  missionId: string;
  missionTitle: string;
  spentUsd: number;
  budgetUsd: number;
  /** 0-100 */
  pctUsed: number;
  status: string;
}

/**
 * Codex provider wall, read from the newest `backend_pauses` row with
 * backend='codex' for the team. Null when Codex has never been paused.
 */
export interface CodexBudgetForecast {
  kind: 'codex';
  isExhausted: boolean;
  /** 'budget' (usage/rate limit) | 'auth' (credential rejected). */
  reason: string;
  /** ISO string; null if not currently exhausted */
  resetsAt: string | null;
  exhaustedAt: string | null;
}

/**
 * Dispatch multi-tenant Claude wall, read from `tenant_budgets`. This is a
 * Claude pool, not Codex. It used to be reported as the Codex line.
 */
export interface ClaudeTenantBudgetForecast {
  kind: 'claude_tenant';
  isExhausted: boolean;
  /** ISO string; null if not currently exhausted */
  resetsAt: string | null;
  exhaustedAt: string | null;
}

export interface BudgetForecast {
  monthly: MonthlyBudgetForecast | null;
  codex: CodexBudgetForecast | null;
  claudeTenant: ClaudeTenantBudgetForecast | null;
  missions: MissionBudgetForecast[];
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export interface MonthlyBudgetInput {
  budgetUsd: number;
  spentUsd: number;
  resetsAt: Date;
  /** costUsd per worker in the last 24h trailing window */
  recentWorkerCosts: number[];
  now: Date;
}

export interface MissionBudgetInput {
  missionId: string;
  missionTitle: string;
  spentUsd: number;
  budgetUsd: number;
  status: string;
}

/**
 * Compute monthly budget forecast from raw inputs.
 * Pure function — no DB access.
 */
export function computeMonthlyBudgetForecast(input: MonthlyBudgetInput): MonthlyBudgetForecast {
  const { budgetUsd, spentUsd, resetsAt, recentWorkerCosts, now } = input;
  const pctUsed = Math.round((spentUsd / budgetUsd) * 100);

  const totalRecentCost = recentWorkerCosts.reduce((s, c) => s + c, 0);
  const burnRateUsdPerDay = recentWorkerCosts.length > 0 ? totalRecentCost : null;

  const remaining = budgetUsd - spentUsd;
  const msToReset = resetsAt.getTime() - now.getTime();
  const daysToReset = msToReset / (24 * 60 * 60 * 1000);

  let daysToDepletion: number | null = null;
  if (burnRateUsdPerDay !== null && burnRateUsdPerDay > 0) {
    const rawDays = remaining / burnRateUsdPerDay;
    // Cap at the reset date — budget refills then regardless
    daysToDepletion = Math.min(rawDays, Math.max(0, daysToReset));
  }

  const confidence = computeBurnRateConfidence(recentWorkerCosts);

  return {
    kind: 'monthly',
    spentUsd,
    budgetUsd,
    pctUsed,
    resetsAt: resetsAt.toISOString(),
    burnRateUsdPerDay,
    daysToDepletion,
    confidence,
  };
}

/**
 * Derive confidence level from a sample of recent per-worker cost values.
 * Variance check: coefficient of variation (stddev/mean) > 1 → low.
 */
export function computeBurnRateConfidence(costs: number[]): ConfidenceLevel {
  if (costs.length < 5) return 'low';

  // Compute coefficient of variation
  const mean = costs.reduce((s, c) => s + c, 0) / costs.length;
  if (mean === 0) return 'low';
  const variance = costs.reduce((s, c) => s + (c - mean) ** 2, 0) / costs.length;
  const cv = Math.sqrt(variance) / mean;

  if (cv >= 0.9) return 'low';
  if (costs.length > 20) return 'high';
  return 'medium';
}

/**
 * Sort missions by % spent descending.
 */
export function computeMissionBudgetForecast(missions: MissionBudgetInput[]): MissionBudgetForecast[] {
  return missions
    .map(m => ({
      missionId: m.missionId,
      missionTitle: m.missionTitle,
      spentUsd: m.spentUsd,
      budgetUsd: m.budgetUsd,
      pctUsed: Math.round((m.spentUsd / m.budgetUsd) * 100),
      status: m.status,
    }))
    .sort((a, b) => b.pctUsed - a.pctUsed);
}

// ── Server-side data fetcher ──────────────────────────────────────────────────

/** Statuses that can still accrue spend and are relevant to the forecast. */
export const ACTIVE_MISSION_STATUSES = ['active', 'paused', 'budget_exhausted'] as const;

/** How far back we look for the burn rate trailing window (24 hours). */
const BURN_WINDOW_MS = 24 * 60 * 60 * 1000;

type MissionQueryRow = {
  id: string;
  title: string;
  costBudgetUsd: string | null;
  status: string;
  teamId: string;
  workspaceId: string | null;
};

/**
 * Compute a full budget forecast for a team.
 * Runs entirely server-side; never throws — returns partial data on errors.
 */
export async function getBudgetForecast(
  teamId: string,
  scopedWsIds: string[],
  opts: {
    /**
     * Only the month's spend and the provider walls (Health › Overview):
     * mission budgets are neither read nor computed, and come back empty.
     */
    summaryOnly?: boolean;
  } = {},
): Promise<BudgetForecast> {
  const now = new Date();
  const summaryOnly = opts.summaryOnly === true;

  // The first round's independent reads go in one round trip (readRound); if
  // that batch fails, each is read alone so one failing read costs only its
  // part of the forecast, as before.
  const reads = {
    // Team monthly budget
    teamRow: db.query.teams.findFirst({
      where: sqlWhere(eq(teams.id, teamId)),
      columns: {
        monthlyBudgetUsd: true,
        monthlyCostUsd: true,
        monthlyCostMonth: true,
      },
    }),

    // Active missions in scope with a cost budget. Includes:
    //   • workspace-scoped missions (workspaceId in scopedWsIds)
    //   • team-level missions (workspaceId IS NULL, teamId matches) — same logic as missions page
    // Excludes: completed, archived, and cancelled statuses that can no longer accrue spend.
    // paused is kept because the mission can be resumed; budget_exhausted is kept because
    // the row is still informative headroom context and may transition back on budget reset.
    missionRows: summaryOnly ? null : db.query.missions.findMany({
      where: sqlWhere(and(
        scopedWsIds.length > 0
          ? or(
              inArray(missions.workspaceId, scopedWsIds),
              and(isNull(missions.workspaceId), eq(missions.teamId, teamId)),
            )
          : and(isNull(missions.workspaceId), eq(missions.teamId, teamId)),
        isNotNull(missions.costBudgetUsd),
        inArray(missions.status, [...ACTIVE_MISSION_STATUSES]),
      )),
      columns: {
        id: true,
        title: true,
        costBudgetUsd: true,
        status: true,
        teamId: true,
        workspaceId: true,
      },
    }),

    // Dispatch-tenant Claude budget exhaustion (a Claude pool, not Codex)
    tenantRow: db.query.tenantBudgets.findFirst({
      where: sqlWhere(eq(tenantBudgets.teamId, teamId)),
      orderBy: sqlOrderBy([desc(tenantBudgets.updatedAt)]),
      columns: {
        budgetExhaustedAt: true,
        budgetResetsAt: true,
      },
    }),

    // Recent worker costs (last 24h) — for the pool burn rate across all scoped workspaces
    recentWorkerRows: scopedWsIds.length > 0
      ? db
          .select({ costUsd: workers.costUsd })
          .from(workers)
          .where(and(
            inArray(workers.workspaceId, scopedWsIds),
            gte(workers.createdAt, new Date(now.getTime() - BURN_WINDOW_MS)),
            sql`${workers.costUsd} > 0`,
            // The burn rate projects the credit pool, which real usage never
            // draws on (countsTowardAgentSdkCreditPool).
            sql`${workers.costBasis} IS DISTINCT FROM ${'real'}`,
          ))
      : null,

    // Codex provider wall — newest codex pause for the team. Provider pools
    // are team-wide, so this is not scoped by workspace.
    codexPauseRow: db.query.backendPauses.findFirst({
      where: sqlWhere(and(eq(backendPauses.teamId, teamId), eq(backendPauses.backend, 'codex'))),
      orderBy: sqlOrderBy([desc(backendPauses.resetsAt)]),
      columns: { resetsAt: true, createdAt: true, reason: true },
    }),
  };
  const round = await readRound(reads).catch(async () => {
    const one = async <T>(q: PromiseLike<T> | null): Promise<T | null> => (q ? await Promise.resolve(q).catch(() => null) : null);
    const [teamRow, missionRows, tenantRow, recentWorkerRows, codexPauseRow] = await Promise.all([
      one(reads.teamRow), one(reads.missionRows),
      one(reads.tenantRow), one(reads.recentWorkerRows), one(reads.codexPauseRow),
    ]);
    return { teamRow, missionRows, tenantRow, recentWorkerRows, codexPauseRow };
  });
  const teamRow = round.teamRow ?? null;
  const missionRows = (round.missionRows ?? []) as MissionQueryRow[];
  const tenantRow = round.tenantRow ?? null;
  const recentWorkerRows = (round.recentWorkerRows ?? []) as { costUsd: string }[];
  const codexPauseRow = round.codexPauseRow ?? null;


  // ── Monthly budget ──────────────────────────────────────────────────────────
  let monthly: MonthlyBudgetForecast | null = null;

  const envBudgetUsd = process.env.BUDGET_MONTHLY_USD ? parseFloat(process.env.BUDGET_MONTHLY_USD) : null;
  const rawBudgetUsd = teamRow?.monthlyBudgetUsd ? parseFloat(teamRow.monthlyBudgetUsd as string) : null;
  const budgetUsd = rawBudgetUsd ?? envBudgetUsd;

  if (budgetUsd && budgetUsd > 0) {
    const spentUsd = teamRow?.monthlyCostUsd ? parseFloat(teamRow.monthlyCostUsd as string) : 0;
    const recentWorkerCosts = (recentWorkerRows as { costUsd: string }[])
      .map(r => parseFloat(r.costUsd))
      .filter(v => v > 0);

    // Monthly budget resets at the start of next month UTC
    const currentMonth = teamRow?.monthlyCostMonth ?? now.toISOString().slice(0, 7);
    const [year, month] = currentMonth.split('-').map(Number);
    const resetsAt = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));

    monthly = computeMonthlyBudgetForecast({ budgetUsd, spentUsd, resetsAt, recentWorkerCosts, now });
  }

  // ── Mission budgets ─────────────────────────────────────────────────────────
  const missionForecasts: MissionBudgetInput[] = [];
  const activeMissionStatuses = new Set<string>(ACTIVE_MISSION_STATUSES);

  const budgeted = (missionRows as MissionQueryRow[]).filter(m =>
    // Belt-and-suspenders: SQL WHERE already applies these filters, but guard
    // here too so unit tests and any future query changes stay honest.
    !!m.costBudgetUsd && activeMissionStatuses.has(m.status) && m.teamId === teamId && !!parseFloat(m.costBudgetUsd));
  if (budgeted.length > 0) {
    try {
      // Every budgeted mission's spend in one grouped read (same sum as getMissionSpendUsd).
      const spendRows = await db
        .select({ missionId: tasks.missionId, spend: sql<string>`COALESCE(SUM(${workers.costUsd}), '0')` })
        .from(workers)
        .innerJoin(tasks, eq(tasks.id, workers.taskId))
        .where(and(inArray(tasks.missionId, budgeted.map(m => m.id)), sql`${workers.costBasis} IS DISTINCT FROM ${'virtual'}`))
        .groupBy(tasks.missionId);
      const spendByMission = new Map(spendRows.map(r => [r.missionId as string, parseFloat(r.spend ?? '0')]));
      for (const m of budgeted) {
        missionForecasts.push({
          missionId: m.id, missionTitle: m.title, spentUsd: spendByMission.get(m.id) ?? 0,
          budgetUsd: parseFloat(m.costBudgetUsd!), status: m.status,
        });
      }
    } catch {
      // Mission budgets drop out rather than failing the forecast
    }
  }

  // ── Codex provider wall ─────────────────────────────────────────────────────
  let codex: CodexBudgetForecast | null = null;
  if (codexPauseRow) {
    const row = codexPauseRow as { resetsAt: Date; createdAt: Date; reason: string };
    const resetsAt = new Date(row.resetsAt);
    const isExhausted = resetsAt.getTime() > now.getTime();
    codex = {
      kind: 'codex',
      isExhausted,
      reason: row.reason,
      resetsAt: isExhausted ? resetsAt.toISOString() : null,
      exhaustedAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    };
  }

  // ── Dispatch-tenant Claude budget ───────────────────────────────────────────
  let claudeTenant: ClaudeTenantBudgetForecast | null = null;
  if (tenantRow) {
    const row = tenantRow as { budgetResetsAt: Date; budgetExhaustedAt: Date | null };
    const resetsAt = new Date(row.budgetResetsAt);
    const isExhausted = resetsAt.getTime() > now.getTime();
    claudeTenant = {
      kind: 'claude_tenant',
      isExhausted,
      resetsAt: isExhausted ? resetsAt.toISOString() : null,
      exhaustedAt: row.budgetExhaustedAt ? new Date(row.budgetExhaustedAt).toISOString() : null,
    };
  }

  return {
    monthly,
    codex,
    claudeTenant,
    missions: computeMissionBudgetForecast(missionForecasts),
  };
}
