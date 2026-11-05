// What a team may spend on buildd's Voyage key in a month, and whether that is
// being enforced. Pure, so the runner and tests load it with no database. Spec:
// docs/specs/voyage-spend-guard.md. The guard that applies it is
// ./knowledge-store/voyage-guard.ts.
//
// The plan decides the platform key only: Free gets none, paid plans get a
// fair-use allowance. A team's own Voyage key is never limited here.
//
// The plan is read through `normalizePlan`, but not through `entitlements()`:
// entitlements are unlimited while BILLING_ENFORCED is off, and this protects the
// operator's Voyage key whether or not billing is live.

import { isBillingEnforced, normalizePlan } from './entitlements';

type Env = Record<string, string | undefined>;

export type VoyageKind = 'embed' | 'rerank';

/** Secret purpose holding a team's own Voyage key. */
export const VOYAGE_KEY_PURPOSE = 'voyage_api_key' as const;

/** Whose key paid for a call. */
export type VoyageKeySource = 'platform' | 'byok';

/** Paid plans' monthly fair-use allowance in tokens, unless VOYAGE_PAID_*_TOKENS says otherwise. */
export const PAID_VOYAGE_EMBED_TOKENS = 500_000_000;
export const PAID_VOYAGE_RERANK_TOKENS = 2_000_000_000;

/**
 * How far past the embed cap a query embedding may run. Without it, one large
 * ingest would also switch off vector search for the rest of the month.
 */
export const VOYAGE_QUERY_HEADROOM = 0.1;

/** Share of a cap at which the team is warned. */
export const VOYAGE_WARN_FRACTION = 0.8;

export interface VoyageCaps {
  embed: number | null;
  rerank: number | null;
}

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

/** VOYAGE_BUDGET_ENFORCED says on or off; unset, it follows BILLING_ENFORCED. */
export function isVoyageBudgetEnforced(env: Env = process.env): boolean {
  const raw = env.VOYAGE_BUDGET_ENFORCED?.trim().toLowerCase();
  if (raw && ON.has(raw)) return true;
  if (raw && OFF.has(raw)) return false;
  return isBillingEnforced(env);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** A team's monthly platform-key allowance. Free has none; so does any unknown plan. */
export function voyageCapsForPlan(plan: string | null | undefined, env: Env = process.env): VoyageCaps {
  if (normalizePlan(plan) === 'free') return { embed: 0, rerank: 0 };
  return {
    embed: positiveInt(env.VOYAGE_PAID_EMBED_TOKENS, PAID_VOYAGE_EMBED_TOKENS),
    rerank: positiveInt(env.VOYAGE_PAID_RERANK_TOKENS, PAID_VOYAGE_RERANK_TOKENS),
  };
}

/** The ceiling one call reserves against: only a query embedding gets headroom. */
export function voyageCapFor(caps: VoyageCaps, kind: VoyageKind, inputType?: 'document' | 'query'): number | null {
  const cap = caps[kind];
  if (cap === null) return null;
  return kind === 'embed' && inputType === 'query' ? Math.floor(cap * (1 + VOYAGE_QUERY_HEADROOM)) : cap;
}

/** Teams metered but never capped (VOYAGE_BUDGET_EXEMPT_TEAMS, comma-separated ids). */
export function isVoyageExempt(teamId: string, env: Env = process.env): boolean {
  return (env.VOYAGE_BUDGET_EXEMPT_TEAMS ?? '').split(',').some(id => id.trim() === teamId);
}

/** Tokens in a text, by the same conservative ratio the embedder plans with. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Voyage bills rerank as query tokens x documents, plus the documents' own tokens. */
export function estimateRerankTokens(query: string, documents: readonly string[]): number {
  const queryTokens = estimateTextTokens(query);
  return documents.reduce((sum, d) => sum + queryTokens + estimateTextTokens(d), 0);
}

/** The budget month, as `YYYY-MM` in UTC. */
export function voyageMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** When the current budget month ends. */
export function voyageMonthResetsAt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** `lexical_only`: the plan has no platform allowance and the team has no key of its own. */
export type VoyageBudgetState = 'ok' | 'near' | 'over' | 'lexical_only';

/** Where a team on the platform key stands. `denied`: a call was already refused this month. */
export function voyageBudgetState(
  used: { embed: number; rerank: number },
  caps: VoyageCaps,
  denied: boolean,
): VoyageBudgetState {
  if (caps.embed === 0 && caps.rerank === 0) return 'lexical_only';
  if (denied) return 'over';
  const shares = (['embed', 'rerank'] as const).map(k => {
    const cap = caps[k];
    return cap ? used[k] / cap : 0;
  });
  const worst = Math.max(...shares);
  if (worst >= 1) return 'over';
  return worst >= VOYAGE_WARN_FRACTION ? 'near' : 'ok';
}
