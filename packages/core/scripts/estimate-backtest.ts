/**
 * Estimate backtest report: replay completed work tasks through the current
 * size estimator (neighbours, then bucket) using only data older than each
 * task, and score against what the work took.
 *
 * Usage:
 *   DATABASE_URL=... bun run packages/core/scripts/estimate-backtest.ts
 *   ... --workspace <uuid>        restrict to one workspace
 *   ... --held-out <uuid>         cold start: that workspace estimated with no local history
 *   ... --clusters                also score area clusters alone vs neighbours alone
 *   ... --blend [--limit N]       also score the blended estimator (task-estimate.ts) against the
 *                                 current one on the same N most recent tasks (default 200)
 *   ... --json                    machine-readable output
 *
 * Needs the vector store (embedding key) for neighbour lookup; without it
 * every task falls to the bucket and the report says so.
 */
import { buildBacktestReport, formatBacktestReport, median } from '../estimate-backtest';
import { loadReplayInput, replayTasks, type ReplayTask } from '../estimate-backtest-source';
import { compareClustersToNeighbours, formatClusterComparison, replayClusters } from '../estimate-backtest-clusters';
import { loadClusterInput } from '../task-area-clusters-source';
import { TASK_AREA_FALLBACK } from '../task-area-prediction';
import { findNeighbourTasks, type TaskAreaQuerier } from '../task-area-prediction-source';
import { TASK_SIZE_NEIGHBOURS_K } from '../task-size-estimate';
import { compareBlend, formatBlendComparison, type PairedRow } from '../estimate-backtest-blend';
import { estimateTask } from '../task-estimate';
import { loadEstimateInputs } from '../task-estimate-source';

const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };

async function main() {
  const json = process.argv.includes('--json');
  const heldOut = flag('held-out');
  const wantClusters = process.argv.includes('--clusters');
  const scope = { workspaceId: heldOut ?? flag('workspace') };
  const input = wantClusters ? await loadClusterInput(scope) : { ...(await loadReplayInput(scope)), clusterTasks: [] };

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

  // With --blend, score only the N most recent completed tasks (both arms), so a run
  // does N neighbour lookups instead of one per task in history. Sessions stay whole:
  // neighbours are sized from them.
  const blendLimit = process.argv.includes('--blend') ? Number(flag('limit') ?? 200) : null;
  const replayed = blendLimit === null ? input.tasks : [...input.tasks]
    .filter(t => t.completedAt)
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .slice(0, blendLimit);
  const only = blendLimit === null ? undefined : new Set(replayed.map(t => t.id));
  let done = 0;
  const findNeighboursLogged = async (t: ReplayTask) => { const r = await findNeighbours(t); if (++done % 25 === 0) console.error(`[backtest] neighbours ${done}/${replayed.length}`); return r; };
  const rows = await replayTasks(input.tasks, input.sessions, { findNeighbours: findNeighboursLogged, heldOut: !!heldOut, only });
  const report = buildBacktestReport(rows);
  const tokens = median(rows.map(r => r.actualTokens).filter(x => x > 0));
  let comparison = null;
  if (wantClusters) {
    const actuals = new Map(rows.map(r => [r.taskId, r.actual]));
    const clusterRows = await replayClusters(input.tasks, input.clusterTasks, actuals, { findNeighbours, heldOut: !!heldOut });
    comparison = compareClustersToNeighbours(rows, clusterRows);
  }
  let blend = null;
  if (process.argv.includes('--blend')) {
    const limit = Number(flag('limit') ?? 200);
    const byId = new Map(input.tasks.map(t => [t.id, t]));
    const sample = rows.filter(r => r.actual > 0 && byId.has(r.taskId))
      .sort((a, b) => +new Date(byId.get(b.taskId)!.createdAt) - +new Date(byId.get(a.taskId)!.createdAt))
      .slice(0, limit);
    const paired: PairedRow[] = [];
    let b = 0;
    for (const r of sample) {
      if (++b % 25 === 0) console.error(`[backtest] blend ${b}/${sample.length}`);
      const t = byId.get(r.taskId)!;
      const inputs = await loadEstimateInputs(
        { id: t.id, workspaceId: t.workspaceId, title: t.title, description: t.description, kind: t.kind, complexity: t.complexity, createdAt: t.createdAt, pathManifest: t.pathManifest },
        store ? { storeFactory: async () => store! } : { storeFactory: async () => { throw new Error('no store'); } },
      );
      const e = estimateTask(heldOut ? { ...inputs, neighbours: null, clusters: null } : inputs);
      paired.push({ taskId: r.taskId, actual: r.actual, priorCompleted: r.priorCompleted, current: { p50: r.p50, p80: r.p80 }, currentSource: r.source, blend: { p50: e.p50Minutes, p80: e.p80Minutes } });
    }
    blend = compareBlend(paired);
  }
  if (json) { process.stdout.write(JSON.stringify({ report, comparison, blend, medianActualTokens: tokens, lookupFailures, storeError }) + '\n'); return; }
  console.log(formatBacktestReport(report, heldOut ? 'Estimate backtest (held-out workspace, cold start)' : 'Estimate backtest'));
  console.log(`Actual tokens (input+output) per task, median: ${tokens === null ? '–' : Math.round(tokens)}. The estimator does not predict tokens yet.`);
  console.log('Bucket rows use the rule verdict (M), not the Jev bucket model. p80 is not produced by the estimator, so coverage is blank.');
  if (comparison) console.log(formatClusterComparison(comparison));
  if (blend) console.log(formatBlendComparison(blend));
  if (storeError) console.log(`Neighbour store unavailable: ${storeError}`);
  if (lookupFailures) console.log(`Neighbour lookups failed: ${lookupFailures}`);
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
