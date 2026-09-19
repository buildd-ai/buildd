/**
 * The one number, for both predictors, over the same tasks.
 *
 * Overlap between the paths a predictor named before the work started and the
 * paths the task's diff actually touched at completion. Computed for:
 *
 *  - **neighbour** — the union of what similar completed tasks touched
 *    (`./task-area-prediction.ts`), and
 *  - **regex** — `inferPathsFromText`, the inference already shipped and
 *    already serving ~57% of prompts.
 *
 * Both over the SAME rows in the SAME run. Without the regex column the
 * neighbour number cannot be read: "half or better" is meaningless against a
 * baseline that may already score the same. A readout that says the new
 * predictor is no better than the regex is a complete, publishable result and
 * this module is built to state it plainly rather than to find a win.
 *
 * ── Why arms are never pooled ──────────────────────────────────────────────
 *
 * Both arms compute both predictions, so a naive reading is "just pool them,
 * the predictor doesn't depend on the arm". It does, indirectly: in the
 * treatment arm the prediction scoped the agent's retrieval, so it had a chance
 * to influence which files the agent then touched — the ground truth is
 * partly downstream of the prediction. Treatment recall is therefore an upper
 * bound contaminated by exactly the mechanism under test, and the control arm
 * is where the predictor is measured against files it could not have steered.
 * `formatTaskAreaReadout` prints them separately and offers no pooled figure.
 *
 * Pure — no DB. The query half is `./task-area-readout-source.ts`.
 */
import { pathAreaOverlap, type PathOverlap, type TaskAreaArm } from './task-area-prediction';

/** The two predictors compared. */
export type PredictorKey = 'neighbour' | 'regex';

/** One scored task: the stored row plus its ground truth. */
export interface TaskAreaRow {
  taskId: string;
  arm: TaskAreaArm;
  policyVersion: string;
  predictedPathSource: 'diff' | 'manifest';
  predictedPaths: string[];
  regexPaths: string[];
  /** NULL while the task has not finished, or finished touching nothing. */
  actualPaths: string[] | null;
  neighboursConsidered: number;
  topScore: number | null;
}

export interface PredictorStats {
  /** Tasks with ground truth, i.e. the denominator every mean below uses. */
  scored: number;
  /** Of those, how many the predictor named at least one path for. */
  withPrediction: number;
  meanRecall: number;
  meanPrecision: number;
  meanExactRecall: number;
  meanPredictedPaths: number;
  /** Share of scored tasks where recall was 1 — the whole diff was inside the prediction. */
  fullCoverageShare: number;
  /** Share of scored tasks where recall was 0, including the ones it predicted nothing for. */
  missShare: number;
}

export interface ArmStats {
  arm: TaskAreaArm;
  /** Rows assigned this arm, including ones with no ground truth yet. */
  assigned: number;
  /** Rows with ground truth. */
  scored: number;
  /** Mean number of neighbours the store returned before the similarity floor. */
  meanNeighboursConsidered: number;
  /** Share of scored rows where the store returned no usable neighbour at all. */
  noNeighbourShare: number;
  predictors: Record<PredictorKey, PredictorStats>;
}

export interface TaskAreaReadout {
  policyVersion: string;
  /** Distinct path sources present. More than one means rows are not comparable. */
  pathSources: Array<'diff' | 'manifest'>;
  rows: number;
  scored: number;
  arms: ArmStats[];
  /**
   * True when nothing can be said yet: no row has ground truth. Distinct from
   * "the predictors tied", which is a result.
   */
  indeterminate: boolean;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function share(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function predictorPaths(row: TaskAreaRow, predictor: PredictorKey): string[] {
  return predictor === 'neighbour' ? row.predictedPaths : row.regexPaths;
}

function statsFor(rows: TaskAreaRow[], predictor: PredictorKey): PredictorStats {
  const overlaps: Array<{ paths: string[]; overlap: PathOverlap }> = rows.map(row => {
    const paths = predictorPaths(row, predictor) ?? [];
    return { paths, overlap: pathAreaOverlap(paths, row.actualPaths) };
  });

  return {
    scored: overlaps.length,
    withPrediction: overlaps.filter(o => o.paths.length > 0).length,
    meanRecall: mean(overlaps.map(o => o.overlap.recall)),
    meanPrecision: mean(overlaps.map(o => o.overlap.precision)),
    meanExactRecall: mean(overlaps.map(o => o.overlap.exactRecall)),
    meanPredictedPaths: mean(overlaps.map(o => o.overlap.predicted)),
    fullCoverageShare: share(overlaps.filter(o => o.overlap.recall >= 1).length, overlaps.length),
    missShare: share(overlaps.filter(o => o.overlap.recall === 0).length, overlaps.length),
  };
}

/**
 * Aggregate stored rows into the readout.
 *
 * A row without `actualPaths` is counted in `assigned` and excluded from every
 * mean. It is not a zero: a task still running, or one that changed no files,
 * says nothing about either predictor, and averaging it in would make the
 * headline a function of how many research tasks landed in the window.
 */
export function computeTaskAreaReadout(rows: readonly TaskAreaRow[], policyVersion: string): TaskAreaReadout {
  const arms: TaskAreaArm[] = ['regex_paths', 'neighbour_area'];
  const scoredRows = rows.filter(r => Array.isArray(r.actualPaths) && r.actualPaths.length > 0);

  const armStats: ArmStats[] = arms.map(arm => {
    const assigned = rows.filter(r => r.arm === arm);
    const scored = scoredRows.filter(r => r.arm === arm);
    return {
      arm,
      assigned: assigned.length,
      scored: scored.length,
      meanNeighboursConsidered: mean(scored.map(r => r.neighboursConsidered)),
      noNeighbourShare: share(scored.filter(r => r.neighboursConsidered === 0).length, scored.length),
      predictors: {
        neighbour: statsFor(scored, 'neighbour'),
        regex: statsFor(scored, 'regex'),
      },
    };
  });

  return {
    policyVersion,
    pathSources: [...new Set(rows.map(r => r.predictedPathSource))].sort(),
    rows: rows.length,
    scored: scoredRows.length,
    arms: armStats,
    indeterminate: scoredRows.length === 0,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Render the readout as text.
 *
 * Deliberately states the comparison rather than a verdict. There is no
 * significance test here and no "winner" line: this experiment's exit is one
 * function and one advisory table, so the decision costs a conversation, not a
 * stopping rule — and a fabricated verdict on a handful of tasks would be the
 * confident nonsense `docs/design/experiment-lifecycle.md` §4 already catalogues.
 */
export function formatTaskAreaReadout(readout: TaskAreaReadout): string {
  const lines: string[] = [];
  lines.push(`task-area prediction — ${readout.policyVersion}`);
  lines.push(`rows: ${readout.rows} · scored (diff recorded): ${readout.scored}`);
  if (readout.pathSources.length > 1) {
    lines.push(
      `WARNING: rows span more than one neighbour path source (${readout.pathSources.join(', ')}).`,
      '  These are different predictors. Segment by source or bump the policy version.',
    );
  } else if (readout.pathSources.length === 1) {
    lines.push(`neighbour paths taken from: ${readout.pathSources[0]}`);
  }

  if (readout.indeterminate) {
    lines.push('');
    lines.push('No task has recorded a diff yet — nothing is measurable. This is');
    lines.push('"cannot see", not "no difference".');
    return lines.join('\n');
  }

  for (const arm of readout.arms) {
    lines.push('');
    lines.push(`── arm ${arm.arm} — assigned ${arm.assigned}, scored ${arm.scored}`);
    if (arm.scored === 0) {
      lines.push('   no scored rows in this arm');
      continue;
    }
    lines.push(
      `   neighbours returned: mean ${arm.meanNeighboursConsidered.toFixed(1)}` +
      ` · none at all for ${pct(arm.noNeighbourShare)} of tasks`,
    );
    lines.push('   predictor    recall  precis  exact   paths  full   miss   had-pred');
    for (const key of ['neighbour', 'regex'] as PredictorKey[]) {
      const s = arm.predictors[key];
      lines.push(
        `   ${key.padEnd(12)}` +
        `${pct(s.meanRecall).padStart(6)}  ` +
        `${pct(s.meanPrecision).padStart(6)}  ` +
        `${pct(s.meanExactRecall).padStart(6)}  ` +
        `${s.meanPredictedPaths.toFixed(1).padStart(5)}  ` +
        `${pct(s.fullCoverageShare).padStart(5)}  ` +
        `${pct(s.missShare).padStart(5)}  ` +
        `${String(s.withPrediction).padStart(4)}/${s.scored}`,
      );
    }
  }

  lines.push('');
  lines.push('recall = share of the actual diff covered by the prediction (headline).');
  lines.push('precis = share of predicted paths that covered something real — recall');
  lines.push('         alone is won by predicting the whole repo, so read them together.');
  lines.push('paths  = mean paths predicted; a recall win on twice the paths is not a win.');
  lines.push('Arms are never pooled: in neighbour_area the prediction scoped the agent\'s');
  lines.push('retrieval, so its ground truth is partly downstream of the prediction.');
  lines.push('Compare predictors WITHIN an arm; read regex_paths for the clean contrast.');
  return lines.join('\n');
}
