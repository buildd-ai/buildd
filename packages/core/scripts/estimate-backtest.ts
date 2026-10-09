/**
 * Estimate backtest report: replay completed work tasks through the current
 * size estimator (neighbours, then bucket) using only data older than each
 * task, and score against what the work took.
 *
 * Usage:
 *   DATABASE_URL=... bun run packages/core/scripts/estimate-backtest.ts
 *   ... --workspace <uuid>        restrict to one workspace
 *   ... --held-out <uuid>         cold start: that workspace estimated with no local history
 *   ... --json                    machine-readable output
 *
 * Needs the vector store (embedding key) for neighbour lookup; without it
 * every task falls to the bucket and the report says so.
 */
import { buildBacktestReport, formatBacktestReport, median } from '../estimate-backtest';
import { loadReplayInput, replayTasks, type ReplayTask } from '../estimate-backtest-source';
import { TASK_AREA_FALLBACK } from '../task-area-prediction';
import { findNeighbourTasks, type TaskAreaQuerier } from '../task-area-prediction-source';
import { TASK_SIZE_NEIGHBOURS_K } from '../task-size-estimate';

const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };

async function main() {
  const json = process.argv.includes('--json');
  const heldOut = flag('held-out');
  const input = await loadReplayInput({ workspaceId: heldOut ?? flag('workspace') });

  let store: TaskAreaQuerier | null = null;
  let storeError: string | null = null;
  if (!heldOut) {
    try {
      const { PgVectorStore, getVoyageEmbedder } = await import('../knowledge-store');
      store = new PgVectorStore(getVoyageEmbedder()) as unknown as TaskAreaQuerier;
    } catch (e) { storeError = (e as Error).message; }
  }
  let lookupFailures = 0;
  const findNeighbours = async (t: ReplayTask) => {
    if (!store) return [];
    try {
      const found = await findNeighbourTasks(store, {
        workspaceId: t.workspaceId, taskId: t.id,
        seedText: [t.title, t.description ?? ''].filter(Boolean).join('\n'),
        config: { ...TASK_AREA_FALLBACK, topK: Math.max(TASK_SIZE_NEIGHBOURS_K * 2, TASK_AREA_FALLBACK.topK) },
      });
      return found.map(n => n.taskId);
    } catch { lookupFailures++; return []; }
  };

  const rows = await replayTasks(input.tasks, input.sessions, { findNeighbours, heldOut: !!heldOut });
  const report = buildBacktestReport(rows);
  const tokens = median(rows.map(r => r.actualTokens).filter(x => x > 0));
  if (json) { process.stdout.write(JSON.stringify({ report, medianActualTokens: tokens, lookupFailures, storeError }) + '\n'); return; }
  console.log(formatBacktestReport(report, heldOut ? 'Estimate backtest (held-out workspace, cold start)' : 'Estimate backtest'));
  console.log(`Actual tokens (input+output) per task, median: ${tokens === null ? '–' : Math.round(tokens)}. The estimator does not predict tokens yet.`);
  console.log('Bucket rows use the rule verdict (M), not the Jev bucket model. p80 is not produced by the estimator, so coverage is blank.');
  if (storeError) console.log(`Neighbour store unavailable: ${storeError}`);
  if (lookupFailures) console.log(`Neighbour lookups failed: ${lookupFailures}`);
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
