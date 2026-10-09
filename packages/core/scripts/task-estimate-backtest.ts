/**
 * Task size backtest, by hand: replay completed work tasks and score the
 * neighbour-median baseline (and any candidate added to `candidates` below)
 * on agent minutes and tokens.
 *
 * Usage:
 *   DATABASE_URL=... bun run backtest:task-estimate
 *   DATABASE_URL=... bun run backtest:task-estimate -- --cold-start
 *   DATABASE_URL=... bun run backtest:task-estimate -- --workspace <id> --json
 *
 * Flags:
 *   --cold-start      hide each task's own workspace history (new-repo behaviour)
 *   --workspace <id>  score only this workspace's tasks
 *   --limit <n>       cap on tasks replayed (default 5000)
 *   --json            machine-readable report on stdout
 *
 * Exit 0 for any computed report, including "no better" and "no neighbours";
 * non-zero only when there was nothing to replay.
 */
import { computeBacktestReport, formatBacktestReport, runBacktest, type SizePredictor } from '../task-estimate-backtest';
import { neighbourMedianBaseline } from '../task-estimate-baseline';
import { fetchTaskOutcomes, vectorNeighbours } from '../task-estimate-backtest-source';
import type { TaskAreaQuerier } from '../task-area-prediction-source';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** Candidates scored beside the baseline, on the same rows. */
const candidates: SizePredictor[] = [];

async function main(): Promise<void> {
  const workspaceId = flag('workspace');
  const limit = flag('limit') ? Number(flag('limit')) : undefined;
  // History must span every workspace so a cold start has something to learn
  // from; only the scored cohort is narrowed.
  const outcomes = await fetchTaskOutcomes({ limit });
  if (outcomes.length === 0) {
    console.error('[task-estimate backtest] no completed work tasks with a finished session');
    process.exit(1);
  }

  const { PgVectorStore, getVoyageEmbedder } = await import('../knowledge-store');
  const store = new PgVectorStore(getVoyageEmbedder()) as unknown as TaskAreaQuerier;
  const baseline = neighbourMedianBaseline();
  const run = await runBacktest(outcomes, {
    predictors: [baseline, ...candidates],
    neighbours: vectorNeighbours(store),
    coldStart: has('cold-start'),
    workspaceIds: workspaceId ? [workspaceId] : undefined,
  });
  const report = computeBacktestReport(run, baseline.name);

  if (has('json')) process.stdout.write(JSON.stringify(report) + '\n');
  else console.log(formatBacktestReport(report));
  process.exit(0);
}

main().catch(err => {
  console.error('[task-estimate backtest] Error:', err);
  process.exit(1);
});
