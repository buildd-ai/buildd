import type { ResultMeta } from './types';

/**
 * Token accounting for a finished session.
 *
 * Why this exists: the completion path used to read `result.usage.byModel` and
 * nothing else. On seat-based (OAuth) auth the SDK does not populate that map,
 * so every OAuth worker persisted inputTokens/outputTokens = 0 — which in turn
 * left the server with no usable consumption signal for budget pacing (turns
 * were reported, tokens never were).
 *
 * SDK shapes vary by version and auth mode, so read every known source in
 * order and defensively:
 *   1. `usage.byModel` — per-model breakdown (also gives model attribution)
 *   2. top-level `usage` totals — snake_case or camelCase
 *   3. the per-turn tally the runner accumulates from assistant messages
 *
 * Cache reads count: the context is re-sent every turn, so cache_read tokens are
 * the bulk of real consumption on long sessions and must be included — that is
 * what makes this number a proxy for context size.
 */

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Pull totals out of a raw SDK `result` message. Returns null when unusable. */
export function extractResultUsage(result: unknown): TokenTotals | null {
  const usage = (result as any)?.usage;
  if (!usage || typeof usage !== 'object') return null;

  // 1. Per-model breakdown.
  const byModel = usage.byModel;
  if (byModel && typeof byModel === 'object' && Object.keys(byModel).length > 0) {
    let inputTokens = 0, outputTokens = 0;
    for (const entry of Object.values(byModel) as any[]) {
      inputTokens += num(entry?.inputTokens) + num(entry?.cacheReadInputTokens) + num(entry?.cacheCreationInputTokens);
      outputTokens += num(entry?.outputTokens);
    }
    if (inputTokens > 0 || outputTokens > 0) return { inputTokens, outputTokens };
  }

  // 2. Top-level totals — snake_case (API shape) or camelCase (SDK shape).
  const inputTokens =
    num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens) +
    num(usage.inputTokens) + num(usage.cacheReadInputTokens) + num(usage.cacheCreationInputTokens);
  const outputTokens = num(usage.output_tokens) + num(usage.outputTokens);
  if (inputTokens > 0 || outputTokens > 0) return { inputTokens, outputTokens };

  return null;
}

/**
 * Final totals for the worker update: result metadata first, then the totals the
 * result carried, then the per-turn tally. Null means nothing was reported and
 * the caller should omit the fields rather than write zeros.
 */
export function aggregateUsage(
  resultMeta: (ResultMeta & { totalUsage?: TokenTotals | null }) | undefined,
  turnTally: TokenTotals,
): TokenTotals | null {
  if (resultMeta?.modelUsage && Object.keys(resultMeta.modelUsage).length > 0) {
    let inputTokens = 0, outputTokens = 0;
    for (const usage of Object.values(resultMeta.modelUsage) as any[]) {
      inputTokens += num(usage?.inputTokens) + num(usage?.cacheReadInputTokens) + num(usage?.cacheCreationInputTokens);
      outputTokens += num(usage?.outputTokens);
    }
    if (inputTokens > 0 || outputTokens > 0) return { inputTokens, outputTokens };
  }

  const carried = resultMeta?.totalUsage;
  if (carried && (num(carried.inputTokens) > 0 || num(carried.outputTokens) > 0)) {
    return { inputTokens: num(carried.inputTokens), outputTokens: num(carried.outputTokens) };
  }

  if (num(turnTally.inputTokens) > 0 || num(turnTally.outputTokens) > 0) {
    return { inputTokens: num(turnTally.inputTokens), outputTokens: num(turnTally.outputTokens) };
  }

  return null;
}
