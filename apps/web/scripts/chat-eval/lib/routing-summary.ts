/**
 * What routing did across a set of questions, from each turn's content-free
 * `RoutingRecord`: how many calls answered, fell to low confidence or failed
 * (by kind), and their latency. Pure, so `questions --classify --timeout 900`
 * can report the production deadline's fallback rate.
 */
import type { RoutingRecord } from '../../../src/lib/chat/routing';

export interface RoutingSummary {
  total: number;
  outcomes: Record<string, number>;
  latencyMs: { p50: number; p90: number; max: number } | null;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function summarizeRouting(records: readonly RoutingRecord[]): RoutingSummary {
  const outcomes: Record<string, number> = {};
  for (const r of records) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const lat = records.map(r => r.latencyMs).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  return {
    total: records.length,
    outcomes,
    latencyMs: lat.length ? { p50: percentile(lat, 50), p90: percentile(lat, 90), max: lat[lat.length - 1] } : null,
  };
}

export function formatRoutingSummary(s: RoutingSummary, timeoutMs: number): string {
  const parts = Object.entries(s.outcomes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n} (${Math.round((n / s.total) * 100)}%)`);
  const lat = s.latencyMs ? `latency p50 ${s.latencyMs.p50}ms, p90 ${s.latencyMs.p90}ms, max ${s.latencyMs.max}ms` : 'no latency';
  return `routing at ${timeoutMs}ms over ${s.total}: ${parts.join(', ') || 'nothing'}; ${lat}`;
}

/** `--timeout <ms>`: a positive whole number of milliseconds, else the default. */
export function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--timeout takes milliseconds, e.g. --timeout 900 (got '${raw}')`);
  return n;
}
