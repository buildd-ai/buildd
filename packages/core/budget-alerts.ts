/**
 * Monthly budget tracking + threshold alerting.
 *
 * Accumulates spend per calendar month and reports which alert thresholds a new
 * charge newly crosses, so callers can fire a notification once per threshold
 * per month. Pure logic — no DB or I/O — so it is unit-testable in isolation.
 *
 * Context: as of 2026-06-15 the Claude Agent SDK draws from a fixed monthly
 * credit pool (e.g. $100), billed at list rates with no rollover. This tracks
 * consumption against that pool regardless of auth type.
 */

/** Percent-of-budget thresholds that trigger an alert. */
export const BUDGET_ALERT_THRESHOLDS = [50, 80, 100] as const;

/** Calendar-month key in UTC, e.g. "2026-06". Credit pools reset on the 1st. */
export function budgetMonthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface BudgetState {
  /** Spend accumulated so far in `monthlyCostMonth`. */
  monthlyCostUsd: number;
  /** Month the accumulated spend belongs to (budgetMonthKey), or null if never set. */
  monthlyCostMonth: string | null;
  /** Thresholds already alerted this month. */
  alertsSent: number[];
}

export interface BudgetApplyResult {
  /** New month-to-date spend (resets to the charge alone on a new month). */
  monthlyCostUsd: number;
  /** Month the new spend belongs to. */
  monthlyCostMonth: string;
  /** Updated set of thresholds that have been alerted this month. */
  alertsSent: number[];
  /** Thresholds newly crossed by this charge — caller should notify for each. */
  crossed: number[];
}

/**
 * Apply a new charge to the running monthly total and detect threshold crossings.
 *
 * - Resets the running total (and alert state) when `now` is in a new month.
 * - Only counts positive, finite charges.
 * - Crossings fire once per threshold per month, even if a single charge jumps
 *   past several thresholds at once.
 */
export function applyBudgetUsage(
  state: BudgetState,
  addCostUsd: number,
  budgetUsd: number | null | undefined,
  now: Date,
): BudgetApplyResult {
  const month = budgetMonthKey(now);
  const sameMonth = state.monthlyCostMonth === month;
  const base = sameMonth ? state.monthlyCostUsd : 0;
  const alertsSent = sameMonth ? [...state.alertsSent] : [];

  const add = Number.isFinite(addCostUsd) && addCostUsd > 0 ? addCostUsd : 0;
  const monthlyCostUsd = base + add;

  const crossed: number[] = [];
  if (budgetUsd && budgetUsd > 0) {
    const pct = (monthlyCostUsd / budgetUsd) * 100;
    for (const threshold of BUDGET_ALERT_THRESHOLDS) {
      if (pct >= threshold && !alertsSent.includes(threshold)) {
        crossed.push(threshold);
        alertsSent.push(threshold);
      }
    }
  }

  return { monthlyCostUsd, monthlyCostMonth: month, alertsSent, crossed };
}
