/**
 * Dollar figures for agent work are estimates, never invoices.
 *
 * `workers.costUsd` is either the SDK's own client-side estimate or, when the
 * SDK reports $0 (seat/OAuth, credit pools), a list-price reconstruction from
 * token counts. On a subscription seat nothing is billed per token, so the
 * figure is a list-price equivalent. Which billing mode produced a given row is
 * not reliably known yet (account auth type is set at account creation, not
 * from the credential in use), so every spend figure carries the label.
 *
 * Pure and dependency-free: safe to import from client components.
 */

export const ESTIMATED_COST_TITLE =
  'Estimated at API list price. On a subscription (OAuth) seat this is a list-price equivalent, not a charge.';

export function formatEstimatedUsd(usd: number | string | null | undefined, digits = 2): string {
  const n = typeof usd === 'string' ? parseFloat(usd) : usd;
  const safe = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return `$${safe.toFixed(digits)} est.`;
}
