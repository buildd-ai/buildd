import { db } from '@buildd/core/db';
import { accounts, backendPauses, tenantBudgets, workers } from '@buildd/core/db/schema';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { effectiveBudgetResetAt, isBudgetExhausted } from './budget-errors';
import type { ReviewerStallFacts } from './reviewer-gate';

/** Render-local caches only: never reuse a previous render's capacity or pauses. */
export function createReviewerStallFactsLoader(now: Date) {
  const seats = new Map<string, Promise<number | null>>();
  const budgets = new Map<string, ReturnType<typeof loadTeamPauses>>();

  // Same account and tenant budget records read by getBudgetForecast, plus the
  // provider pause log used by claim. Forecast pressure is an estimate, not a
  // recorded pause. Unlike the forecast's partial-data fallback, failed reads
  // must stay unknown here: an empty result asserts that no pause was recorded.
  async function loadTeamPauses(teamId: string) {
    try {
      const [accountRows, providerRows, tenantRows] = await Promise.all([
        db.query.accounts.findMany({ where: and(eq(accounts.teamId, teamId), eq(accounts.authType, 'oauth')),
          columns: { budgetExhaustedAt: true, budgetResetsAt: true } }),
        db.query.backendPauses.findMany({ where: and(eq(backendPauses.teamId, teamId), gt(backendPauses.resetsAt, now)),
          columns: { backend: true, reason: true, resetsAt: true } }),
        db.query.tenantBudgets.findMany({ where: eq(tenantBudgets.teamId, teamId),
          columns: { tenantId: true, budgetResetsAt: true } }),
      ]);
      return { accountRows, providerRows, tenantRows };
    } catch {
      return null;
    }
  }

  return {
    async load(workspace: { id: string; teamId: string | null; maxConcurrentTasks: number }, task: {
      context?: Record<string, unknown> | null;
      mission?: { status: string } | null;
    }): Promise<ReviewerStallFacts> {
      if (!seats.has(workspace.id)) {
        // Match the workspace capacity gate's active worker statuses.
        seats.set(workspace.id, db.select({ count: sql<number>`count(*)::int` }).from(workers)
          .where(and(eq(workers.workspaceId, workspace.id), inArray(workers.status, ['running', 'starting', 'idle'])))
          .then(rows => rows[0]?.count ?? null).catch(() => null));
      }
      if (workspace.teamId && !budgets.has(workspace.teamId)) {
        budgets.set(workspace.teamId, loadTeamPauses(workspace.teamId));
      }
      const [inProgress, budget] = await Promise.all([
        seats.get(workspace.id)!, workspace.teamId ? budgets.get(workspace.teamId)! : null,
      ]);
      const budgetPauses: string[] | null = budget ? [] : null;
      if (budget && budgetPauses) {
        // The pause log is append-only. Match claim's latest unexpired reset
        // per backend rather than rendering every observation of the same wall.
        const byBackend = new Map<string, typeof budget.providerRows[number]>();
        for (const p of budget.providerRows) {
          if (p.resetsAt > now && p.resetsAt > (byBackend.get(p.backend)?.resetsAt ?? now)) {
            byBackend.set(p.backend, p);
          }
        }
        for (const p of byBackend.values()) {
          budgetPauses.push(`${p.backend} ${p.reason} pause until ${p.resetsAt.toISOString()}`);
        }
        const tenantId = (task.context?.tenantContext as { tenantId?: string } | undefined)?.tenantId;
        if (tenantId) {
          for (const t of budget.tenantRows) {
            if (t.tenantId === tenantId && t.budgetResetsAt > now) {
              budgetPauses.push(`tenant budget pause until ${t.budgetResetsAt.toISOString()}`);
            }
          }
        } else {
          // No claiming account is known at render time. Name the scope rather
          // than claiming that any one account's pause blocks this task.
          let latestAccountReset: Date | null = null;
          for (const a of budget.accountRows) {
            if (isBudgetExhausted(a.budgetExhaustedAt, a.budgetResetsAt, now)) {
              const reset = effectiveBudgetResetAt(a.budgetExhaustedAt!, a.budgetResetsAt);
              if (!latestAccountReset || reset > latestAccountReset) latestAccountReset = reset;
            }
          }
          if (latestAccountReset) budgetPauses.push(`team account budget pause until ${latestAccountReset.toISOString()}`);
        }
        if (task.mission?.status === 'budget_exhausted') budgetPauses.push('mission budget exhausted');
      }
      return {
        seats: inProgress === null ? null : { inProgress, maxConcurrentTasks: workspace.maxConcurrentTasks },
        budgetPauses: budgetPauses === null ? null : [...new Set(budgetPauses)],
      };
    },
  };
}
