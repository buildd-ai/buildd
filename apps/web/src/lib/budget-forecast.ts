import { db } from '@buildd/core/db';
import { accounts, teams, missions, workers, tasks, tenantBudgets, oauthBudgetEpisodes } from '@buildd/core/db/schema';
import { and, eq, gte, inArray, isNotNull, desc, sql } from 'drizzle-orm';
import {
  learnOauthCapacity,
  oauthBudgetPressure,
  windowEndsAt,
  readPacingConfig,
  type BudgetConfidence,
} from '@buildd/core/oauth-budget';
import { loadOauthEpisodes, measureOauthWindow } from '@/lib/oauth-budget-window';

// ── Public types ──────────────────────────────────────────────────────────────

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface OauthSessionForecast {
  kind: 'oauth';
  accountId: string;
  accountName: string;
  /** 0-100 */
  pressurePct: number;
  windowEndsAt: string;
  /** null = still learning (< 3 episodes) */
  confidence: ConfidenceLevel | null;
  limiter: string | null;
  episodes: number;
  state: 'learning' | 'active';
}

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

export interface CodexBudgetForecast {
  kind: 'codex';
  isExhausted: boolean;
  /** ISO string; null if not currently exhausted */
  resetsAt: string | null;
  exhaustedAt: string | null;
}

export interface BudgetForecast {
  oauthSessions: OauthSessionForecast[];
  monthly: MonthlyBudgetForecast | null;
  codex: CodexBudgetForecast | null;
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

/**
 * Map oauth-budget's BudgetConfidence → our ConfidenceLevel.
 * Returns null when there's not enough data yet (learning state).
 */
export function oauthEpisodeConfidence(c: BudgetConfidence): ConfidenceLevel | null {
  if (c === 'none') return null;
  if (c === 'low') return 'low';
  return 'high';
}

// ── Server-side data fetcher ──────────────────────────────────────────────────

/** How far back we look for the burn rate trailing window (24 hours). */
const BURN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Max OAuth accounts to probe per team (avoids fan-out on large teams). */
const MAX_OAUTH_ACCOUNTS = 8;

type OauthAccountRow = { id: string; name: string; seatId: string | null; budgetResetsAt: Date | null };

/**
 * Group OAuth account rows by seatId.
 * Null seatId → each account is its own group (keyed by account.id).
 * Non-null seatId → all accounts sharing the same seatId form one group.
 * Exported for unit testing.
 */
export function groupOauthAccountsBySeatId(
  accounts: OauthAccountRow[],
): Map<string, OauthAccountRow[]> {
  const groups = new Map<string, OauthAccountRow[]>();
  for (const account of accounts) {
    const key = account.seatId ?? account.id;
    const existing = groups.get(key) ?? [];
    existing.push(account);
    groups.set(key, existing);
  }
  return groups;
}

/**
 * Compute a full budget forecast for a team.
 * Runs entirely server-side; never throws — returns partial data on errors.
 */
export async function getBudgetForecast(
  teamId: string,
  scopedWsIds: string[],
): Promise<BudgetForecast> {
  const now = new Date();

  const [teamRow, oauthAccounts, missionRows, tenantRow, recentWorkerRows] = await Promise.all([
    // Team monthly budget
    db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: {
        monthlyBudgetUsd: true,
        monthlyCostUsd: true,
        monthlyCostMonth: true,
      },
    }).catch(() => null),

    // OAuth accounts for this team (seat-based)
    db.query.accounts.findMany({
      where: and(
        eq(accounts.teamId, teamId),
        eq(accounts.authType, 'oauth'),
      ),
      columns: { id: true, name: true, seatId: true, budgetResetsAt: true },
      limit: MAX_OAUTH_ACCOUNTS,
    }).catch(() => [] as OauthAccountRow[]),

    // Active missions in scope with a cost budget
    scopedWsIds.length > 0
      ? db.query.missions.findMany({
          where: and(
            inArray(missions.workspaceId, scopedWsIds),
            isNotNull(missions.costBudgetUsd),
          ),
          columns: {
            id: true,
            title: true,
            costBudgetUsd: true,
            status: true,
          },
        }).catch(() => [] as { id: string; title: string; costBudgetUsd: string | null; status: string }[])
      : Promise.resolve([] as { id: string; title: string; costBudgetUsd: string | null; status: string }[]),

    // Codex tenant budget exhaustion
    db.query.tenantBudgets.findFirst({
      where: eq(tenantBudgets.teamId, teamId),
      orderBy: [desc(tenantBudgets.updatedAt)],
      columns: {
        budgetExhaustedAt: true,
        budgetResetsAt: true,
      },
    }).catch(() => null),

    // Recent worker costs (last 24h) — for burn rate across all scoped workspaces
    scopedWsIds.length > 0
      ? db
          .select({ costUsd: workers.costUsd })
          .from(workers)
          .where(and(
            inArray(workers.workspaceId, scopedWsIds),
            gte(workers.createdAt, new Date(now.getTime() - BURN_WINDOW_MS)),
            sql`${workers.costUsd} > 0`,
          ))
          .catch(() => [] as { costUsd: string }[])
      : Promise.resolve([] as { costUsd: string }[]),
  ]);

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

  // ── OAuth session forecasts ─────────────────────────────────────────────────
  const pacingConfig = readPacingConfig(process.env);

  const oauthSessions: OauthSessionForecast[] = [];
  const config = pacingConfig;

  // Group accounts by seatId so shared-subscription rows are measured together.
  const accountGroups = groupOauthAccountsBySeatId(oauthAccounts as OauthAccountRow[]);

  for (const group of accountGroups.values()) {
    try {
      const accountIds = group.map(a => a.id);
      // Label with most-recently-active account name; fall back to comma-list if all unnamed.
      const label = group.find(a => a.name)?.name || group.map(a => a.id).join(', ');
      // Representative account for UI key (first in group)
      const representativeId = group[0].id;

      const episodes = await loadOauthEpisodes(accountIds);
      const capacity = learnOauthCapacity(episodes, { quantile: config.quantile });
      const { windowStartedAt, usage } = await measureOauthWindow({
        accountIds,
        now,
        lastResetsAt: episodes[0]?.resetsAt ?? null,
      });
      const pressure = oauthBudgetPressure({ usage, capacity });
      const windowEnd = windowEndsAt(windowStartedAt);
      const confidence = oauthEpisodeConfidence(capacity.confidence);

      oauthSessions.push({
        kind: 'oauth',
        accountId: representativeId,
        accountName: label,
        pressurePct: Math.round(pressure.pct * 100),
        windowEndsAt: windowEnd.toISOString(),
        confidence,
        limiter: pressure.limiter,
        episodes: capacity.samples,
        state: capacity.confidence === 'none' ? 'learning' : 'active',
      });
    } catch {
      // Skip groups that fail rather than crashing the whole forecast
    }
  }

  // ── Mission budgets ─────────────────────────────────────────────────────────
  const missionForecasts: MissionBudgetInput[] = [];

  for (const m of missionRows as { id: string; title: string; costBudgetUsd: string | null; status: string }[]) {
    if (!m.costBudgetUsd) continue;
    const budgetMUsd = parseFloat(m.costBudgetUsd);
    if (!budgetMUsd) continue;

    try {
      // Compute mission spend inline (same as getMissionSpendUsd)
      const result = await db
        .select({ spend: sql<string>`COALESCE(SUM(${workers.costUsd}), '0')` })
        .from(workers)
        .innerJoin(tasks, eq(tasks.id, workers.taskId))
        .where(eq(tasks.missionId, m.id));
      const spentMUsd = parseFloat(result[0]?.spend ?? '0');
      missionForecasts.push({ missionId: m.id, missionTitle: m.title, spentUsd: spentMUsd, budgetUsd: budgetMUsd, status: m.status });
    } catch {
      // Skip failing missions
    }
  }

  // ── Codex tenant budget ─────────────────────────────────────────────────────
  let codex: CodexBudgetForecast | null = null;
  if (tenantRow) {
    const resetsAt = new Date((tenantRow as { budgetResetsAt: Date }).budgetResetsAt);
    const isExhausted = resetsAt.getTime() > now.getTime();
    codex = {
      kind: 'codex',
      isExhausted,
      resetsAt: isExhausted ? resetsAt.toISOString() : null,
      exhaustedAt: (tenantRow as { budgetExhaustedAt: Date }).budgetExhaustedAt
        ? new Date((tenantRow as { budgetExhaustedAt: Date }).budgetExhaustedAt).toISOString()
        : null,
    };
  }

  return {
    oauthSessions,
    monthly,
    codex,
    missions: computeMissionBudgetForecast(missionForecasts),
  };
}
