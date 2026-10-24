#!/usr/bin/env bun
/**
 * Repeatable evaluation of the `buildd.ui_copy` detector: `bun run eval:ui-copy`.
 *
 * Runs the versioned corpus through the production evaluation flow (`runUiCopyBenchmark` in
 * scripts/ui-copy-benchmark.ts: executeUiVerification -> broker -> runBuilddDecision, the kind's own
 * questions, interpretation and the stored measurement policy). Offline by default; a provider is called
 * only with `--network`, through buildd's own model.inference capability route under the worker's approved
 * grant (the server holds the key and writes the usage ledger; this command needs no database and no key).
 *
 *   bun run eval:ui-copy                                   # offline replay of the development split
 *   BUILDD_SERVER=… BUILDD_API_KEY=… BUILDD_WORKER_ID=… bun run eval:ui-copy --network --max-decisions 12
 *   bun run eval:ui-copy --split untouched --open-untouched   # the reserved split, deliberately
 *
 * Flags:
 *   --corpus <path>         default packages/core/eval/ui-copy/corpus-v1.json
 *   --split development|untouched|all   (default development; the others need --open-untouched)
 *   --case <id>             only this case (repeatable)
 *   --limit <n>             first n selected cases
 *   --cache <path>          default .decision-data/ui-copy-benchmark-cache.json (gitignored)
 *   --corrections <path>    person-confirmed corrections, JSONL (see parseUiCopyCorrections)
 *   --model <id>            offline: which model's cached answers to replay (default the platform's Jev)
 *   --measurement-policy <fingerprint>   offline: which recorded measurement policy to reapply; needed only
 *                           when the cache holds more than one
 *   --network [--server <url>] [--worker <id>]   (env BUILDD_SERVER, BUILDD_API_KEY, BUILDD_WORKER_ID)
 *   --max-decisions <n>     network: provider invocations (default 12, at most 60)
 *   --max-cost-usd <x>      network: stop issuing calls once spend reaches this (default 0.01, at most 0.10)
 *   --json <path>           write the full report as JSON
 *
 * Exit 0 only when every selected case got the evidence it needs. That says the measurement is complete,
 * not that the detector is good: read the false positives, false negatives and abstentions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyUiCopyCache, formatUiCopyBenchmark, parseUiCopyCache, type UiCopySplit } from '../packages/core/eval/ui-copy-benchmark';
import { grantRouteConfigured } from './ui-copy-grant-transport';
import { DEFAULT_CACHE, DEFAULT_CORPUS, runUiCopyBenchmark, type UiCopyBenchmarkDeps, type UiCopyBenchmarkOptions } from './ui-copy-benchmark';

export interface UiCopyEvalIo {
  env?: Record<string, string | undefined>;
  /** Seams for tests only; the command passes none, so production's transport, resolver and loader run. */
  deps?: UiCopyBenchmarkDeps;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Run the command for `argv` (without the bun and script path). Resolves to the exit code. */
export async function runUiCopyEval(argv: readonly string[], io: UiCopyEvalIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? (l => console.log(l));
  const err = io.err ?? (l => console.error(`[ui-copy-eval] ${l}`));
  const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const args = (name: string) => argv.flatMap((v, i) => (v === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));
  const flag = (name: string) => argv.includes(`--${name}`);

  const split = (arg('split') ?? 'development') as UiCopySplit | 'all';
  if (!['development', 'untouched', 'all'].includes(split)) { err('--split must be development, untouched or all'); return 1; }
  const cachePath = arg('cache') ?? DEFAULT_CACHE;
  let network: UiCopyBenchmarkOptions['network'] = null;
  if (flag('network')) {
    network = {
      server: arg('server') ?? env.BUILDD_SERVER ?? null, apiKey: env.BUILDD_API_KEY ?? null, workerId: arg('worker') ?? env.BUILDD_WORKER_ID ?? null,
      maxDecisions: Number(arg('max-decisions') ?? 12), maxCostUsd: Number(arg('max-cost-usd') ?? 0.01),
    };
    // No fallback: without a server route every case has no answer and the report says INCOMPLETE.
    if (!grantRouteConfigured(network)) err('network route not configured (BUILDD_SERVER, BUILDD_API_KEY, BUILDD_WORKER_ID): no case can be answered, the run will be INCOMPLETE');
  }
  const result = await runUiCopyBenchmark({
    corpus: JSON.parse(readFileSync(arg('corpus') ?? DEFAULT_CORPUS, 'utf8')),
    split, openUntouched: flag('open-untouched'), ids: args('case'),
    limit: arg('limit') ? Number(arg('limit')) : undefined,
    cache: existsSync(cachePath) ? parseUiCopyCache(JSON.parse(readFileSync(cachePath, 'utf8'))) : emptyUiCopyCache(),
    corrections: arg('corrections') ? readFileSync(arg('corrections')!, 'utf8') : null,
    model: arg('model'), measurementPolicy: arg('measurement-policy') ?? null, network,
  }, io.deps);
  if (!result.ok) { for (const p of result.problems) err(p); return 1; }
  // A network run always records the measurement policy it applied, even when every answer was cached.
  if (result.newEntries || network) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(result.cache, null, 2)}\n`);
  }
  out(formatUiCopyBenchmark(result.report));
  const jsonPath = arg('json');
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(result.report, null, 2)}\n`);
  return result.report.status === 'complete' ? 0 : 1;
}

if (import.meta.main) {
  runUiCopyEval(process.argv.slice(2)).then(code => process.exit(code), e => {
    console.error(`[ui-copy-eval] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
