/**
 * Report: claim-time memory index injection, flag off vs on, over the golden
 * query set (eval/golden-queries.json). Offline and deterministic; see
 * ./memory-index-compare for what is measured and how.
 *
 * Usage:
 *   bun packages/core/scripts/eval-memory-index.ts [--budget <tokens>] [--json]
 */
import { readFileSync } from 'fs';
import path from 'path';
import { compareMemoryIndex, formatComparison, type GoldenQueryLike } from './memory-index-compare';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);

export function loadGoldenQueries(file = path.join(SCRIPT_DIR, 'eval', 'golden-queries.json')): GoldenQueryLike[] {
  const data = JSON.parse(readFileSync(file, 'utf8')) as { curated?: Array<{ id: string; query: string }> };
  return (data.curated ?? []).map(q => ({ id: q.id, query: q.query }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const budgetArg = args.indexOf('--budget');
  const budget = budgetArg >= 0 ? Number(args[budgetArg + 1]) : undefined;
  const report = compareMemoryIndex(loadGoldenQueries(), Number.isFinite(budget) ? budget : undefined);
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatComparison(report));
}
