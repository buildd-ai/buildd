import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';
import {
  isVoyageBudgetEnforced,
  isVoyageExempt,
  voyageCapsForPlan,
  voyageMonth,
  type EmbeddingProvider,
  type VoyageKind,
} from '@buildd/core/voyage-budget';
import { embeddingConfigFromEnv } from '@buildd/core/knowledge-store/embedding-config';
import { ADMIN_WINDOWS, type AdminWindow } from './scope';

/**
 * Voyage usage for the platform-owner admin API (GET /api/admin/embedding-usage).
 * Read-only over voyage_usage_daily (per day, team, kind, model, corpus, caller)
 * and voyage_usage_monthly (the guard's per-team month counters). Cost is an
 * estimate: tokens x a price from VOYAGE_PRICE_TABLE, never a billed figure.
 *
 * Rows also carry an OpenAI-compatible embedding endpoint's calls (key_source
 * `endpoint` or `unmetered`; see packages/core/knowledge-store/voyage-guard.ts):
 * `provider` says which API served them, and an unmetered row costs 0.
 */

export const MAX_ROWS = 5000;

export interface UsageRowIn {
  day: string;
  teamId: string;
  kind: VoyageKind;
  model: string;
  corpus: string;
  caller: string;
  tokens: number;
  calls: number;
  /** voyage_usage_daily.key_source. Absent: a Voyage row. */
  keySource?: string;
}

export interface EmbeddingUsageRow {
  day: string;
  teamId: string;
  provider: EmbeddingProvider;
  /** A free (self-hosted) endpoint: traced and counted, never priced. */
  unmetered: boolean;
  model: string;
  corpus: string;
  caller: string;
  tokens: number;
  calls: number;
  estimatedCostUsd: number | null;
}

/** Which API a daily row's key source means. */
export function providerOfKeySource(keySource: string | undefined): { provider: EmbeddingProvider; unmetered: boolean } {
  if (keySource === 'endpoint') return { provider: 'openai_compat', unmetered: false };
  if (keySource === 'unmetered') return { provider: 'openai_compat', unmetered: true };
  return { provider: 'voyage', unmetered: false };
}

export interface MonthBudget {
  kind: VoyageKind;
  usedTokens: number;
  capTokens: number | null;
  estimatedCostUsd: number | null;
}

export type PriceTable = Record<string, number>;

/**
 * USD per million tokens by model, from VOYAGE_PRICE_TABLE (JSON), plus the
 * deployment's embedding endpoint model at EMBEDDING_PRICE_PER_1M_TOKENS when
 * one is configured and the table does not already price it. Unset or
 * malformed: no prices.
 */
export function loadPriceTable(env: Record<string, string | undefined> = process.env): PriceTable {
  const out: PriceTable = {};
  try {
    const parsed = JSON.parse(env.VOYAGE_PRICE_TABLE ?? '{}');
    for (const [model, price] of Object.entries(parsed ?? {})) {
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) out[model] = price;
    }
  } catch {
    // no table prices
  }
  const endpoint = embeddingConfigFromEnv(env);
  if (endpoint.provider === 'openai_compat' && endpoint.model && endpoint.pricePerMTokens && !(endpoint.model in out)) {
    out[endpoint.model] = endpoint.pricePerMTokens;
  }
  return out;
}

/** null for an unpriced model: an unknown cost is never reported as 0. */
export function estimateCostUsd(tokens: number, model: string, prices: PriceTable): number | null {
  const price = prices[model];
  return price === undefined ? null : (tokens * price) / 1_000_000;
}

/** First UTC day included in a window: the day `since` falls on. */
export function windowStartDay(since: Date): string {
  return since.toISOString().slice(0, 10);
}

/** Merge rows across kind (embed and rerank use different models) into the response grain. */
export function groupRows(rows: UsageRowIn[], prices: PriceTable): EmbeddingUsageRow[] {
  const merged = new Map<string, EmbeddingUsageRow>();
  for (const r of rows) {
    const { provider, unmetered } = providerOfKeySource(r.keySource);
    const key = [r.day, r.teamId, provider, String(unmetered), r.model, r.corpus, r.caller].join('\u0000');
    const cur = merged.get(key);
    if (cur) {
      cur.tokens += r.tokens;
      cur.calls += r.calls;
    } else {
      merged.set(key, { day: r.day, teamId: r.teamId, provider, unmetered, model: r.model, corpus: r.corpus, caller: r.caller, tokens: r.tokens, calls: r.calls, estimatedCostUsd: null });
    }
  }
  const out = [...merged.values()];
  for (const r of out) r.estimatedCostUsd = r.unmetered ? 0 : estimateCostUsd(r.tokens, r.model, prices);
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.teamId.localeCompare(b.teamId) || a.model.localeCompare(b.model) || a.corpus.localeCompare(b.corpus) || a.caller.localeCompare(b.caller));
}

/** Month cost per kind: null if any model that spent tokens that month is unpriced. */
export function monthCost(byModel: Array<{ kind: VoyageKind; model: string; tokens: number; keySource?: string }>, kind: VoyageKind, prices: PriceTable): number | null {
  let total = 0;
  let any = false;
  for (const r of byModel) {
    if (r.kind !== kind || r.tokens <= 0) continue;
    const c = providerOfKeySource(r.keySource).unmetered ? 0 : estimateCostUsd(r.tokens, r.model, prices);
    if (c === null) return null;
    total += c;
    any = true;
  }
  return any ? total : null;
}

export interface MonthTeamRow { teamId: string; plan: string | null; kind: VoyageKind; tokens: number }

/** Platform-wide used tokens per kind, and the sum of the caps the guard applies to those teams (null when not enforced or any team is uncapped). */
export function buildBudgets(
  teams: MonthTeamRow[],
  byModel: Array<{ kind: VoyageKind; model: string; tokens: number; keySource?: string }>,
  prices: PriceTable,
  env: Record<string, string | undefined> = process.env,
): MonthBudget[] {
  const enforced = isVoyageBudgetEnforced(env);
  return (['embed', 'rerank'] as const).map(kind => {
    const mine = teams.filter(t => t.kind === kind);
    let cap: number | null = 0;
    if (!enforced) cap = null;
    else {
      for (const t of mine) {
        if (isVoyageExempt(t.teamId, env)) { cap = null; break; }
        const c = voyageCapsForPlan(t.plan, env)[kind];
        if (c === null) { cap = null; break; }
        cap += c;
      }
    }
    return { kind, usedTokens: mine.reduce((s, t) => s + t.tokens, 0), capTokens: cap, estimatedCostUsd: monthCost(byModel, kind, prices) };
  });
}

export async function loadEmbeddingUsage(window: AdminWindow, now = new Date(), env: Record<string, string | undefined> = process.env) {
  const since = new Date(now.getTime() - ADMIN_WINDOWS[window] * 86_400_000);
  const startDay = windowStartDay(since);
  const month = voyageMonth(now);
  const monthStart = `${month}-01`;
  const prices = loadPriceTable(env);

  const [daily, monthly, monthModels] = await Promise.all([
    db.execute(sql`
      SELECT day::text AS day, team_id::text AS team_id, kind, model, corpus, caller, key_source,
             SUM(tokens)::float8 AS tokens, SUM(calls)::float8 AS calls
      FROM voyage_usage_daily
      WHERE day >= ${startDay}::date
      GROUP BY day, team_id, kind, model, corpus, caller, key_source
      ORDER BY day, team_id
      LIMIT ${MAX_ROWS + 1}
    `),
    db.execute(sql`
      SELECT m.team_id::text AS team_id, t.plan, m.kind, m.tokens::float8 AS tokens
      FROM voyage_usage_monthly m JOIN teams t ON t.id = m.team_id
      WHERE m.month = ${month}
    `),
    db.execute(sql`
      SELECT kind, model, key_source, SUM(tokens)::float8 AS tokens
      FROM voyage_usage_daily
      WHERE day >= ${monthStart}::date
      GROUP BY kind, model, key_source
    `),
  ]);

  const dailyRows = (daily.rows as Array<Record<string, any>>).map(r => ({
    day: String(r.day), teamId: String(r.team_id), kind: r.kind as VoyageKind, model: String(r.model),
    corpus: String(r.corpus), caller: String(r.caller), tokens: Number(r.tokens), calls: Number(r.calls),
    keySource: r.key_source == null ? undefined : String(r.key_source),
  }));
  const truncated = dailyRows.length > MAX_ROWS;
  const rows = groupRows(dailyRows.slice(0, MAX_ROWS), prices);
  const budgets = buildBudgets(
    (monthly.rows as Array<Record<string, any>>).map(r => ({ teamId: String(r.team_id), plan: r.plan ?? null, kind: r.kind as VoyageKind, tokens: Number(r.tokens) })),
    (monthModels.rows as Array<Record<string, any>>).map(r => ({ kind: r.kind as VoyageKind, model: String(r.model), tokens: Number(r.tokens), keySource: r.key_source == null ? undefined : String(r.key_source) })),
    prices,
    env,
  );

  return {
    schemaVersion: 1 as const,
    window,
    since: since.toISOString(),
    estimate: true as const,
    priceTable: prices,
    rows,
    month: { start: monthStart, budgets },
    truncated,
  };
}
