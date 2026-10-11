/**
 * Real / virtual / mixed / unknown totals, for every rollup that reports cost
 * or tokens (docs/specs/real-and-virtual-cost.md, "Reporting").
 *
 * Client-safe: type-only imports.
 */
import type { CostBasis } from '@buildd/core/cost-basis';

export const BASIS_KEYS = ['real', 'virtual', 'mixed', 'unknown'] as const satisfies readonly CostBasis[];
export type BasisKey = (typeof BASIS_KEYS)[number];

export interface BasisTotals {
  workers: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type BasisSplit = Record<BasisKey, BasisTotals>;

/** Owner-facing names. Virtual dollars are a list-price value, not money spent. */
export const BASIS_LABEL: Record<BasisKey, string> = {
  real: 'Real cost',
  virtual: 'Plan usage at list price',
  mixed: 'Mixed',
  unknown: 'Basis not reported',
};

interface Usage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: string | number | null;
}

const n = (v: string | number | null | undefined) => {
  const x = typeof v === 'string' ? parseFloat(v) : (v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

export function emptySplit(): BasisSplit {
  return Object.fromEntries(
    BASIS_KEYS.map(k => [k, { workers: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }]),
  ) as BasisSplit;
}

/**
 * The bucket a worker's usage belongs in. NULL means the row recorded no
 * usage, so it contributes nothing; a NULL row that carries usage anyway (or
 * an unrecognised value) is unknown, never folded into real or virtual.
 */
export function basisOfRow(basis: string | null | undefined, usage: Usage): BasisKey | null {
  if (basis && (BASIS_KEYS as readonly string[]).includes(basis)) return basis as BasisKey;
  const hasUsage = n(usage.costUsd) > 0 || n(usage.inputTokens) > 0 || n(usage.outputTokens) > 0;
  return hasUsage ? 'unknown' : null;
}

export function addToSplit(split: BasisSplit, basis: BasisKey, usage: Usage): void {
  const b = split[basis];
  b.workers += 1;
  b.inputTokens += n(usage.inputTokens);
  b.outputTokens += n(usage.outputTokens);
  b.costUsd += n(usage.costUsd);
}

/** The combined figure: only ever shown labelled as combined. */
export function splitTotal(split: BasisSplit): BasisTotals {
  const t = { workers: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const k of BASIS_KEYS) {
    t.workers += split[k].workers;
    t.inputTokens += split[k].inputTokens;
    t.outputTokens += split[k].outputTokens;
    t.costUsd += split[k].costUsd;
  }
  return t;
}
