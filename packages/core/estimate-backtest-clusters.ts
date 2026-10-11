/**
 * Clusters-alone vs neighbours-alone, over the same replayed tasks.
 *
 * Neighbours-alone is what `replayTasks` already produced (the rows with
 * source 'neighbours'). Clusters-alone rebuilds the area-cluster model as of a
 * past date (`./task-area-clusters.ts`, createdAt < asOf — the replay's own
 * cutoff) and estimates from it. The new task's area is its pathManifest if it
 * declared one, else the diffs of the neighbours the replay would have used,
 * restricted to neighbours created before the task. Pure; the loaders are
 * `./task-area-clusters-source.ts`.
 *
 * Rebuilding per task is quadratic, so the model is refreshed when the visible
 * history has grown by max(5 tasks, 5%). The snapshot's asOf is the task that
 * triggered the rebuild, which is never later than the tasks scored with it, so
 * a snapshot can only be staler than the cutoff, never ahead of it.
 */
import { scoreRows, type BacktestScore } from './estimate-backtest';
import type { ReplayRow, ReplayTask } from './estimate-backtest-source';
import {
  deriveClusters, estimateFromClusters, mapNewTaskToClusters,
  type ClusterModel, type ClusterTask, type NewTaskPathSource,
} from './task-area-clusters';

export interface ClusterReplayRow {
  taskId: string;
  actual: number;
  p50: number;
  p80: number;
  mappedBy: Exclude<NewTaskPathSource, 'none'>;
  repairRate: number;
}

export interface ClusterReplayDeps {
  /** Neighbour task ids, rank order; may include the task's future. */
  findNeighbours: (task: ReplayTask) => Promise<readonly string[]>;
  heldOut?: boolean;
  /** Minimum visible tasks before a model is built. Default 5. */
  minHistory?: number;
}

export async function replayClusters(
  all: readonly ReplayTask[],
  clusterTasks: readonly ClusterTask[],
  actuals: ReadonlyMap<string, number>,
  deps: ClusterReplayDeps,
): Promise<ClusterReplayRow[]> {
  const minHistory = deps.minHistory ?? 5;
  const filesOf = new Map(clusterTasks.map(t => [t.id, t.files]));
  const createdAt = new Map(all.map(t => [t.id, t.createdAt.getTime()]));
  const ordered = [...all].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const sortedCluster = [...clusterTasks].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let model: ClusterModel | null = null;
  let builtOn = -1;
  const rows: ClusterReplayRow[] = [];
  for (const task of ordered) {
    const actual = actuals.get(task.id) ?? 0;
    if (actual <= 0 || deps.heldOut) continue;
    const cutoff = task.createdAt.getTime();
    const visible = sortedCluster.filter(t => t.createdAt.getTime() < cutoff).length;
    if (visible < minHistory) continue;
    if (!model || visible >= builtOn + Math.max(5, Math.ceil(builtOn * 0.05))) {
      model = deriveClusters(clusterTasks, { asOf: task.createdAt });
      builtOn = visible;
    }

    const manifest = task.pathManifest ?? [];
    let neighbourPaths: string[] = [];
    if (!manifest.length) {
      const ids = (await deps.findNeighbours(task)).filter(id => id !== task.id && (createdAt.get(id) ?? Infinity) < cutoff);
      neighbourPaths = ids.flatMap(id => filesOf.get(id) ?? []);
    }
    const mapped = mapNewTaskToClusters({ pathManifest: manifest, neighbourPaths }, model);
    if (mapped.source === 'none') continue;
    const est = estimateFromClusters(mapped.clusters, model, task);
    if (!est || est.minutes <= 0) continue;
    rows.push({ taskId: task.id, actual, p50: est.minutes, p80: est.p80Minutes, mappedBy: mapped.source, repairRate: est.repairRate });
  }
  return rows;
}

export interface ClusterComparison {
  clustersAlone: BacktestScore;
  neighboursAlone: BacktestScore;
  /** Tasks both could estimate, scored on identical ground. */
  both: { n: number; clusters: BacktestScore; neighbours: BacktestScore };
  /** Tasks with an actual that neither could estimate (they fall to the bucket). */
  neither: number;
  mappedBy: Record<'manifest' | 'neighbours', number>;
}

export function compareClustersToNeighbours(
  replayRows: readonly ReplayRow[],
  clusterRows: readonly ClusterReplayRow[],
): ClusterComparison {
  const nb = replayRows.filter(r => r.source === 'neighbours');
  const nbById = new Map(nb.map(r => [r.taskId, r]));
  const clById = new Map(clusterRows.map(r => [r.taskId, r]));
  const shared = [...clById.keys()].filter(id => nbById.has(id));
  const covered = new Set([...nbById.keys(), ...clById.keys()]);
  return {
    clustersAlone: scoreRows(clusterRows),
    neighboursAlone: scoreRows(nb),
    both: {
      n: shared.length,
      clusters: scoreRows(shared.map(id => clById.get(id)!)),
      neighbours: scoreRows(shared.map(id => nbById.get(id)!)),
    },
    neither: replayRows.filter(r => !covered.has(r.taskId)).length,
    mappedBy: {
      manifest: clusterRows.filter(r => r.mappedBy === 'manifest').length,
      neighbours: clusterRows.filter(r => r.mappedBy === 'neighbours').length,
    },
  };
}

const pct = (x: number | null) => (x === null ? '–' : `${(x * 100).toFixed(0)}%`);
const num = (x: number | null) => (x === null ? '–' : x.toFixed(2));
const line = (label: string, s: BacktestScore) =>
  `| ${label} | ${s.n} | ${s.scored} | ${pct(s.withinP80)} | ${num(s.medianRatio)} | ${num(s.medianAbsLogError)} |`;

export function formatClusterComparison(c: ClusterComparison): string {
  const head = '| | tasks | scored | within p80 | median actual/p50 | median abs log err |\n|---|---|---|---|---|---|';
  return [
    '## Clusters alone vs neighbours alone', '',
    head,
    line('clusters alone', c.clustersAlone),
    line('neighbours alone', c.neighboursAlone),
    '', `### Same ${c.both.n} tasks, both estimators`, head,
    line('clusters', c.both.clusters),
    line('neighbours', c.both.neighbours),
    '',
    `Neither could estimate: ${c.neither}. Clusters mapped by manifest: ${c.mappedBy.manifest}, by neighbour diffs: ${c.mappedBy.neighbours}.`,
    '',
  ].join('\n');
}
