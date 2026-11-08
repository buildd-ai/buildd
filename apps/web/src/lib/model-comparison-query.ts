/**
 * Parse the comparison filters from query parameters, and load the rows for a
 * workspace the caller has already been checked against. Shared by the REST
 * route and the owner page so both read one definition of "the comparison".
 */
import {
  buildModelComparison,
  parseComparisonWindow,
  type BenchmarkPrior,
  type ComparisonFilters,
  type ComparisonRow,
  type ModelComparison,
} from '@buildd/core/model-comparison';
import { listObservationsForComparison } from '@/lib/model-observation-store';

const MAX_FILTER = 80;

function text(v: string | null | undefined): string | undefined {
  const s = (v ?? '').trim();
  return s ? s.slice(0, MAX_FILTER) : undefined;
}

function date(v: string | null | undefined): Date | undefined | 'invalid' {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

export type ParsedFilters = { ok: true; filters: ComparisonFilters } | { ok: false; error: string };

export function parseComparisonFilters(get: (k: string) => string | null | undefined): ParsedFilters {
  const rawWindow = text(get('window'));
  const window = parseComparisonWindow(rawWindow);
  if (rawWindow && !window) return { ok: false, error: 'window must be one of 24h, 7d, 30d, 90d' };
  const since = date(get('since'));
  const until = date(get('until'));
  if (since === 'invalid' || until === 'invalid') return { ok: false, error: 'since and until must be ISO dates' };
  return {
    ok: true,
    filters: {
      model: text(get('model')),
      config: text(get('config')),
      harness: text(get('harness')),
      hardware: text(get('hardware')),
      taskType: text(get('taskType')),
      // Default to 30 days so an unfiltered read is a bounded one.
      window: window ?? (since || until ? undefined : '30d'),
      since: since || undefined,
      until: until || undefined,
    },
  };
}

/** External benchmark priors. None are bundled: a number here must be sourced and dated by a person. */
export const BENCHMARK_PRIORS: readonly BenchmarkPrior[] = [];

export async function loadModelComparison(workspaceId: string, filters: ComparisonFilters): Promise<ModelComparison> {
  const now = new Date();
  // Read a little wider than the window; the pure filter applies the exact one.
  const since = filters.since ?? (filters.window ? new Date(now.getTime() - 91 * 86_400_000) : null);
  const rows = await listObservationsForComparison(workspaceId, since, filters.until ?? null);
  return buildModelComparison(rows as unknown as ComparisonRow[], filters, { now, priors: BENCHMARK_PRIORS });
}
