/**
 * View model for Health > Estimates: the readout (packages/core
 * task-estimate-accuracy.ts) as the one accuracy line a team reads
 * (docs/specs/task-estimates.md, "Team surface"). Pure and client-safe.
 *
 * The per-kind, per-area and per-source breakdowns, tokens and the chart are
 * operator detail and are not rendered here; the team API still returns them.
 */
import type { GroupScore, TaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';

type BacktestScore = TaskEstimateReadout['overall'];

/** Below this many scored tasks no rate is shown, rounded or otherwise. */
export const MIN_SCORED_FOR_VERDICT = 10;

/** Sources that mean the repo had little history to go on. */
const LIMITED_HISTORY_SOURCES = ['prior', 'default'];

export interface EstimatesReadoutView {
  lead: string;
  sample: string | null;
  typical: string | null;
  limitedHistory: string | null;
}

export function estimatesReadout(readout: Pick<TaskEstimateReadout, 'overall' | 'bySource'>): EstimatesReadoutView {
  const { overall } = readout;
  const limitedHistory = limitedHistoryLine(readout.bySource);
  if (overall.scored < MIN_SCORED_FOR_VERDICT || overall.withinP80 == null) {
    return {
      lead: 'Not enough finished tasks to assess estimates.',
      sample: overall.scored > 0 ? `${overall.scored} finished so far.` : null,
      typical: null,
      limitedHistory,
    };
  }
  return {
    lead: `${inTen(overall.withinP80)} in 10 tasks finished within the upper estimate.`,
    sample: `Across ${overall.scored} finished tasks.`,
    typical: typicalBiasLine(overall),
    limitedHistory,
  };
}

/** A share as "X in 10". Never rounds up to 10 or down to 0 unless every or no task did. */
export function inTen(share: number): number {
  const x = Math.round(share * 10);
  if (share < 1 && x >= 10) return 9;
  if (share > 0 && x <= 0) return 1;
  return x;
}

/** The typical overrun or underrun (median actual / p50), only when it is outside 0.85 to 1.15. */
export function typicalBiasLine(score: BacktestScore): string | null {
  const r = score.medianRatio;
  if (r == null || r <= 0 || (r >= 0.85 && r <= 1.15)) return null;
  const x = r > 1 ? r : 1 / r;
  return `Typically ran ${x >= 10 ? Math.round(x) : x.toFixed(1)}x ${r > 1 ? 'longer' : 'shorter'} than estimated.`;
}

/** How many scored estimates leaned mostly on the new-repo prior or on no evidence. A count, never a rate. */
export function limitedHistoryLine(bySource: readonly GroupScore[]): string | null {
  const n = bySource
    .filter(g => LIMITED_HISTORY_SOURCES.includes(g.key))
    .reduce((sum, g) => sum + g.score.scored, 0);
  return n > 0 ? `${n} of these had little history in the repo to go on.` : null;
}
