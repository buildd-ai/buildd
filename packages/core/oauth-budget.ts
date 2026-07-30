/**
 * OAuth budget pacing — learn where this account's session wall actually is.
 *
 * Seat-based (OAuth) accounts have no cost signal: workers report costUsd 0, so
 * the router's budget gate (`dailyBudgetPct`) was permanently 0 for them. The
 * account only ever discovered its ceiling by slamming into it — a worker fails
 * with a session/limit error, `accounts.budgetExhaustedAt` is set, and every
 * queued Claude task stalls until the reset (see the 2026-07-11 and 2026-07-19
 * stalls).
 *
 * This module turns those crashes into a forecast. Each exhaustion records how
 * much work the window actually held (`oauth_budget_episodes`); from the recent
 * episodes we learn a conservative capacity and express the current window's
 * usage as a 0..1 pressure value. That value is fed to the existing model router
 * as `dailyBudgetPct`, so the behaviour we already have for API accounts —
 * downshift tiers under pressure, pause priority-0 work at 95% — starts working
 * for OAuth accounts too, *before* the wall instead of after it.
 *
 * Design notes:
 * - Capacity is the **p25** of observed episodes, not the mean: we would rather
 *   throttle a little early than exhaust the window mid-build and leave
 *   half-finished branches behind.
 * - Fewer than MIN_SAMPLES episodes ⇒ no capacity, pressure 0, zero behaviour
 *   change. The feature is inert until it has evidence.
 * - A metric the runner never reports (turns/tokens are often 0 on OAuth) is
 *   dropped rather than learned as 0 — learning 0 would pin pressure at 100%.
 */

/** Anthropic OAuth plan windows are 5 hours. */
export const OAUTH_WINDOW_MS = 5 * 60 * 60 * 1000;

/** Episodes below this count teach us nothing — stay inert. */
export const MIN_SAMPLES = 3;
/** At/above this count we trust the estimate enough to call it 'good'. */
export const GOOD_SAMPLES = 5;
/** Only the most recent N episodes count; plan limits change over time. */
export const DEFAULT_MAX_SAMPLES = 10;
/** Conservative quantile of observed exhaustion points. */
export const DEFAULT_QUANTILE = 0.25;

/**
 * Single control knob, no settings row and no UI: `OAUTH_BUDGET_PACING`.
 *
 *   unset / 'on'   → pacing enabled, conservative p25 capacity (default)
 *   'off' | '0' | 'false' | 'disabled' → fully inert (pressure always 0)
 *   '0.1'..'0.9'   → enabled, using that quantile as the capacity estimate.
 *                    Lower = more cautious (throttles earlier), higher = braver.
 *
 * Kept as one env var deliberately: it is an operational safety valve, not a
 * product setting, and it must be flippable without a schema or dashboard.
 */
export interface PacingConfig {
  enabled: boolean;
  quantile: number;
}

export function readPacingConfig(env: Record<string, string | undefined> = {}): PacingConfig {
  const raw = (env.OAUTH_BUDGET_PACING ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'disabled') {
    return { enabled: false, quantile: DEFAULT_QUANTILE };
  }
  const numeric = Number.parseFloat(raw);
  if (Number.isFinite(numeric) && numeric > 0 && numeric < 1) {
    return { enabled: true, quantile: numeric };
  }
  return { enabled: true, quantile: DEFAULT_QUANTILE };
}

/** One recorded exhaustion: how much work the window held before it died. */
export interface OauthEpisode {
  exhaustedAt: Date;
  workerCount: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Sonnet-equivalent totals. Absent/0 on episodes recorded before weighting. */
  weightedTurns?: number;
  weightedTokens?: number;
}

/**
 * Model cost weights, in sonnet-equivalents, from published per-token pricing
 * ratios (opus ≈ 5× sonnet, haiku ≈ 0.27× sonnet). A plan window is consumed by
 * *cost*, not by raw turn or token count: 100 opus turns eat roughly 5× the
 * window that 100 haiku turns do. Weighting normalises for that so a capacity
 * learned during an opus-heavy week still applies during a haiku-heavy one.
 *
 * Unknown models weigh 1 (sonnet) — never 0 (would read as free) and never the
 * maximum (would throttle everything on a naming change).
 */
export const MODEL_WEIGHTS = { opus: 5, sonnet: 1, haiku: 0.27 } as const;

export function modelWeight(model: string | null | undefined): number {
  if (!model) return MODEL_WEIGHTS.sonnet;
  const m = model.toLowerCase();
  if (m.includes('opus') || m === 'premium') return MODEL_WEIGHTS.opus;
  if (m.includes('haiku') || m === 'budget') return MODEL_WEIGHTS.haiku;
  return MODEL_WEIGHTS.sonnet;
}

/** Work done in the current (still open) window. */
export interface OauthWindowUsage {
  workerCount: number;
  turns: number;
  /** input + output tokens */
  tokens: number;
  /** turns scaled into sonnet-equivalents via MODEL_WEIGHTS */
  weightedTurns: number;
  /** tokens scaled into sonnet-equivalents via MODEL_WEIGHTS */
  weightedTokens: number;
}

/** One worker's contribution to a window. `model` is the task's resolved model. */
export interface WorkerUsageRow {
  model: string | null | undefined;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

/** Aggregate per-worker rows into raw + model-weighted window totals. */
export function summarizeWindowUsage(rows: WorkerUsageRow[]): OauthWindowUsage {
  let turns = 0, tokens = 0, weightedTurns = 0, weightedTokens = 0;
  for (const row of rows) {
    const weight = modelWeight(row.model);
    const rowTokens = (row.inputTokens || 0) + (row.outputTokens || 0);
    turns += row.turns || 0;
    tokens += rowTokens;
    weightedTurns += (row.turns || 0) * weight;
    weightedTokens += rowTokens * weight;
  }
  return {
    workerCount: rows.length,
    turns,
    tokens,
    weightedTurns: Math.floor(weightedTurns),
    weightedTokens: Math.floor(weightedTokens),
  };
}

export type BudgetConfidence = 'none' | 'low' | 'good';

export interface LearnedOauthCapacity {
  /** Episodes that contributed to the estimate (after dropping degenerate ones). */
  samples: number;
  confidence: BudgetConfidence;
  /** Conservative usage at which this account historically hit the wall; null = not learned. */
  workerCount: number | null;
  turns: number | null;
  tokens: number | null;
  /** Model-weighted equivalents — preferred over the raw metrics when learned. */
  weightedTurns: number | null;
  weightedTokens: number | null;
}

export type BudgetLimiter = 'workers' | 'turns' | 'tokens';

export interface OauthBudgetPressure {
  /** 0..1 — fraction of the learned capacity consumed in the current window. */
  pct: number;
  /** Metric closest to its learned wall, or null when nothing was learned. */
  limiter: BudgetLimiter | null;
  confidence: BudgetConfidence;
  samples: number;
  usage: OauthWindowUsage;
  capacity: LearnedOauthCapacity;
}

/**
 * Conservative quantile: interpolates, then floors. Floor (rather than round)
 * keeps the estimate on the safe side of the observed wall.
 */
function quantileFloor(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const interpolated = sorted[lower] + (pos - lower) * (sorted[upper] - sorted[lower]);
  return Math.floor(interpolated);
}

/**
 * Learn per-metric capacity from recorded episodes. A metric is only learned
 * when at least MIN_SAMPLES episodes reported a positive value for it.
 */
export function learnOauthCapacity(
  episodes: OauthEpisode[],
  opts: { maxSamples?: number; quantile?: number } = {},
): LearnedOauthCapacity {
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const quantile = opts.quantile ?? DEFAULT_QUANTILE;

  // An episode that measured no work at all carries no signal (e.g. the flag was
  // set by a worker that died before doing anything).
  const usable = episodes
    .filter(e => e.workerCount > 0 || e.turns > 0 || e.inputTokens + e.outputTokens > 0)
    .sort((a, b) => b.exhaustedAt.getTime() - a.exhaustedAt.getTime())
    .slice(0, maxSamples);

  const samples = usable.length;
  const confidence: BudgetConfidence =
    samples >= GOOD_SAMPLES ? 'good' : samples >= MIN_SAMPLES ? 'low' : 'none';

  if (confidence === 'none') {
    return {
      samples, confidence,
      workerCount: null, turns: null, tokens: null,
      weightedTurns: null, weightedTokens: null,
    };
  }

  const learn = (pick: (e: OauthEpisode) => number): number | null => {
    const positive = usable.map(pick).filter(v => v > 0);
    if (positive.length < MIN_SAMPLES) return null;
    const capacity = quantileFloor(positive, quantile);
    return capacity > 0 ? capacity : null;
  };

  return {
    samples,
    confidence,
    workerCount: learn(e => e.workerCount),
    turns: learn(e => e.turns),
    tokens: learn(e => e.inputTokens + e.outputTokens),
    weightedTurns: learn(e => e.weightedTurns ?? 0),
    weightedTokens: learn(e => e.weightedTokens ?? 0),
  };
}

/**
 * Express current-window usage as 0..1 pressure against the learned capacity.
 * The binding (highest) metric wins — that is the one about to hit the wall.
 */
export function oauthBudgetPressure(input: {
  usage: OauthWindowUsage;
  capacity: LearnedOauthCapacity;
}): OauthBudgetPressure {
  const { usage, capacity } = input;
  const base = {
    confidence: capacity.confidence,
    samples: capacity.samples,
    usage,
    capacity,
  };

  if (capacity.confidence === 'none') {
    return { ...base, pct: 0, limiter: null };
  }

  // Prefer the model-weighted metric when it was learned: it survives a change
  // in model mix, where a raw turn/token count does not. Raw stays as the
  // fallback for episodes recorded before weighting existed.
  const ratios: Array<{ limiter: BudgetLimiter; pct: number }> = [];
  if (capacity.workerCount) ratios.push({ limiter: 'workers', pct: usage.workerCount / capacity.workerCount });
  if (capacity.weightedTurns) {
    ratios.push({ limiter: 'turns', pct: usage.weightedTurns / capacity.weightedTurns });
  } else if (capacity.turns) {
    ratios.push({ limiter: 'turns', pct: usage.turns / capacity.turns });
  }
  if (capacity.weightedTokens) {
    ratios.push({ limiter: 'tokens', pct: usage.weightedTokens / capacity.weightedTokens });
  } else if (capacity.tokens) {
    ratios.push({ limiter: 'tokens', pct: usage.tokens / capacity.tokens });
  }

  if (ratios.length === 0) {
    return { ...base, pct: 0, limiter: null };
  }

  const binding = ratios.reduce((a, b) => (b.pct > a.pct ? b : a));
  return { ...base, pct: Math.min(1, Math.max(0, binding.pct)), limiter: binding.limiter };
}

/**
 * Infer where the live 5h window opened, by sessionizing worker start times.
 *
 * The real rule is not a rolling clock: a plan window opens at your first
 * request after the previous window expired, and runs 5h from there. So walk the
 * start times forward — the first start after a window's expiry opens the next
 * window — and return the last such boundary.
 *
 * `lastResetsAt` (parsed from the exhaustion error, so authoritative when
 * present) hard-cuts the history: work before it belongs to a dead window.
 *
 * Why this beats a rolling `now - 5h` estimate: with a rolling window, work from
 * the *previous* window leaks into the current one whenever the true boundary is
 * recent, inflating pressure and throttling early for no reason.
 *
 * Returns `now` when the window has not opened yet (no work since the boundary)
 * — usage over an empty window is legitimately zero.
 */
export function inferWindowStart(input: {
  now: Date;
  lastResetsAt: Date | null | undefined;
  workerStarts: Date[];
}): Date {
  const { now } = input;
  const resetMs = input.lastResetsAt ? new Date(input.lastResetsAt).getTime() : NaN;
  // A reset in the future has not happened yet — the current window predates it.
  const cutoff = Number.isFinite(resetMs) && resetMs <= now.getTime() ? resetMs : -Infinity;

  const starts = input.workerStarts
    .map(d => new Date(d).getTime())
    .filter(t => Number.isFinite(t) && t <= now.getTime() && t >= cutoff)
    .sort((a, b) => a - b);

  if (starts.length === 0) return now;

  let windowStart = starts[0];
  for (const start of starts) {
    // Past this window's expiry ⇒ this start opens a fresh window.
    if (start >= windowStart + OAUTH_WINDOW_MS) windowStart = start;
  }
  return new Date(windowStart);
}

/** When the inferred window expires — the earliest time the budget can reopen. */
export function windowEndsAt(windowStart: Date): Date {
  return new Date(windowStart.getTime() + OAUTH_WINDOW_MS);
}

/** One-line log/diagnostic summary. */
export function describeOauthPressure(p: OauthBudgetPressure): string {
  if (p.limiter === null) {
    return `oauth budget pacing inert (${p.samples} episode(s), need ${MIN_SAMPLES})`;
  }
  const fmt = (used: number, cap: number | null) => `${used}/${cap ?? '?'}`;
  return (
    `oauth budget ${Math.round(p.pct * 100)}% [${p.limiter}] ` +
    `(workers ${fmt(p.usage.workerCount, p.capacity.workerCount)}, ` +
    `turns ${fmt(p.usage.turns, p.capacity.turns)}, ` +
    `tokens ${fmt(p.usage.tokens, p.capacity.tokens)}; ` +
    `learned from ${p.samples} episodes, ${p.confidence} confidence)`
  );
}
