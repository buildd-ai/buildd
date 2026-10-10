/** Same ceiling as PATCH /api/teams/[id] (MAX_CHAT_BUDGET_USD). */
export const MAX_BUDGET_USD = 100_000;

export type BudgetParse = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * A budget field: empty means "use the default" (null), which the server
 * resolves to a fixed default, never to unlimited.
 */
export function parseBudgetInput(raw: string): BudgetParse {
  const t = raw.trim();
  const v = t.replace(/\s*\/\s*day$/i, '').replace(/^\$/, '').trim();
  if (!t) return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(v)) return { ok: false, error: 'Enter an amount in dollars, like 20 or 7.50.' };
  const n = Math.round(Number(v) * 100) / 100;
  if (n > MAX_BUDGET_USD) return { ok: false, error: `The most you can set is $${MAX_BUDGET_USD.toLocaleString('en-US')} a day.` };
  return { ok: true, value: n };
}

/** `numeric` columns arrive as strings from the driver. */
export function budgetFromApi(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
