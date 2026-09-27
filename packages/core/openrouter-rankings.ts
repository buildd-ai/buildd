/**
 * OpenRouter usage rankings as a popularity prior (docs/design/tier-weights.md §4a).
 *
 * Pure: parse the `rankings-daily` dataset, map its permaslugs to our model
 * ids, and turn rank into a percentile. The fetch and the cache live in
 * `./openrouter-rankings-source.ts`.
 *
 * Ranks, not token counts: OpenRouter counts tokens with each provider's own
 * tokenizer, so counts do not compare across providers.
 *
 * Licence: the dataset is CC BY 4.0. We do not re-serve it. Scores are read
 * only by the explore allocate step; no API, UI or export returns them.
 */
import { snapshotBase, type CatalogEntry } from './model-catalog';
import { findCatalogEntry } from './model-succession';
import type { PoolSurface } from './tier-pool';

export const OPENROUTER_RANKINGS_URL = 'https://openrouter.ai/api/v1/datasets/rankings-daily';

export type RankingsView = 'tool_calling' | 'programming' | 'text';
export const RANKINGS_VIEWS: readonly RankingsView[] = ['tool_calling', 'programming', 'text'];

/** The views a surface's score averages. */
export const SURFACE_VIEWS: Record<PoolSurface, readonly RankingsView[]> = {
  agent: ['tool_calling', 'programming'],
  chat: ['text'],
};

/** Trailing window, inclusive of the end day. */
export const RANKINGS_WINDOW_DAYS = 28;
/** Top-N the dataset lists before its `other` row. */
export const RANKINGS_TOP_N = 50;
/** Scores older than this are ignored and arms get the neutral prior. */
export const RANKINGS_MAX_AGE_DAYS = 7;
/** The dataset's previous day lands around 02:00 UTC. */
export const RANKINGS_FETCH_AFTER_UTC_HOUR = 3;

export const RANKINGS_CACHE_VERSION = 'v1';

export function rankingsCacheKey(teamId: string, view: RankingsView): string {
  return `or-rankings:${RANKINGS_CACHE_VERSION}:${teamId}:${view}`;
}

/** Marks a team's fetch attempt for the day, so a failed fetch is not retried. */
export function rankingsAttemptKey(teamId: string): string {
  return `or-rankings:${RANKINGS_CACHE_VERSION}:${teamId}:attempt`;
}

const DAY_MS = 86_400_000;

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The request for one view, ending yesterday (UTC). */
export function rankingsRequestUrl(view: RankingsView, now: Date): string {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS);
  const start = new Date(end.getTime() - (RANKINGS_WINDOW_DAYS - 1) * DAY_MS);
  const q = new URLSearchParams({ start_date: utcDay(start), end_date: utcDay(end) });
  // The sampled category dataset is weekly and rejects period=day.
  if (view === 'programming') q.set('category', 'programming');
  else { q.set('modality', view); q.set('period', 'day'); }
  return `${OPENROUTER_RANKINGS_URL}?${q.toString()}`;
}

export interface RankingsRow {
  date: string;
  permaslug: string;
  tokens: number;
}

export interface ParsedRankings {
  asOf: string;
  startDate: string | null;
  endDate: string | null;
  rows: RankingsRow[];
}

/** Parse a response body, or null when it is not the dataset's shape. */
export function parseRankings(raw: unknown): ParsedRankings | null {
  const body = raw as { data?: unknown; meta?: Record<string, unknown> } | null;
  if (!body || !Array.isArray(body.data)) return null;
  const meta = body.meta ?? {};
  const asOf = typeof meta.as_of === 'string' ? meta.as_of : null;
  if (!asOf) return null;
  const rows: RankingsRow[] = [];
  for (const r of body.data as Array<Record<string, unknown>>) {
    const permaslug = typeof r?.model_permaslug === 'string' ? r.model_permaslug : null;
    const tokens = Number(r?.total_tokens);
    if (!permaslug || !Number.isFinite(tokens) || tokens < 0) continue;
    rows.push({ date: typeof r.date === 'string' ? r.date : '', permaslug, tokens });
  }
  return {
    asOf,
    startDate: typeof meta.start_date === 'string' ? meta.start_date : null,
    endDate: typeof meta.end_date === 'string' ? meta.end_date : null,
    rows,
  };
}

/**
 * Our native model id for a permaslug: the catalog entry whose `permaslug`
 * matches, else whose OpenRouter id matches, else null.
 */
export function mapPermaslug(catalog: readonly CatalogEntry[], permaslug: string): string | null {
  if (!permaslug || permaslug === 'other') return null;
  const hit = catalog.find(e => e.permaslug === permaslug) ?? catalog.find(e => e.openRouterId === permaslug);
  return hit ? hit.id : null;
}

export interface ViewScores {
  asOf: string;
  startDate: string | null;
  endDate: string | null;
  /** Our model id → percentile in [0, 1]. Absent = outside the top 50 (0). */
  scores: Record<string, number>;
}

/**
 * Sum each model's tokens over the window, rank descending (ties by
 * permaslug), and score `1 − (rank − 1) / 50` for the top 50. `other` is never
 * ranked. Unmapped models keep their rank but are dropped from the scores.
 */
export function scoreRankings(parsed: ParsedRankings, catalog: readonly CatalogEntry[]): { view: ViewScores; unmapped: number } {
  const totals = new Map<string, number>();
  for (const r of parsed.rows) {
    if (r.permaslug === 'other') continue;
    totals.set(r.permaslug, (totals.get(r.permaslug) ?? 0) + r.tokens);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const scores: Record<string, number> = {};
  let unmapped = 0;
  ranked.slice(0, RANKINGS_TOP_N).forEach(([slug], i) => {
    const id = mapPermaslug(catalog, slug);
    if (!id) { unmapped += 1; return; }
    const pctile = 1 - i / RANKINGS_TOP_N;
    if (!(id in scores) || scores[id] < pctile) scores[id] = pctile;
  });
  return { view: { asOf: parsed.asOf, startDate: parsed.startDate, endDate: parsed.endDate, scores }, unmapped };
}

/** Is a cached view fresh enough to use? */
export function isFresh(view: ViewScores, now: Date): boolean {
  const t = Date.parse(view.asOf.length === 10 ? `${view.asOf}T00:00:00Z` : view.asOf);
  return Number.isFinite(t) && now.getTime() - t <= RANKINGS_MAX_AGE_DAYS * DAY_MS;
}

/**
 * An arm model's percentile for a surface: the mean over the surface's fresh
 * views, where a model a fresh view does not list scores 0. Null when no view
 * is fresh, which means the neutral prior. The model matches a scored id the
 * way `priceFromCatalog` does, so every route of one model scores the same.
 */
export function popularityFor(args: {
  model: string;
  surface: PoolSurface;
  views: Partial<Record<RankingsView, ViewScores | null>>;
  catalog: readonly CatalogEntry[];
  now: Date;
}): { pctile: number; views: RankingsView[]; asOf: string } | null {
  const entry = findCatalogEntry(args.catalog, args.model);
  const ids = [...new Set([entry?.id, args.model, snapshotBase(args.model)].filter((x): x is string => !!x).map(x => x.toLowerCase()))];
  const used: RankingsView[] = [];
  let sum = 0;
  let asOf = '';
  for (const v of SURFACE_VIEWS[args.surface]) {
    const view = args.views[v];
    if (!view || !isFresh(view, args.now)) continue;
    const lower: Record<string, number> = {};
    for (const [k, s] of Object.entries(view.scores)) lower[k.toLowerCase()] = s;
    sum += Math.max(0, ...ids.map(id => lower[id] ?? 0));
    used.push(v);
    if (view.asOf > asOf) asOf = view.asOf;
  }
  if (used.length === 0) return null;
  return { pctile: sum / used.length, views: used, asOf };
}
