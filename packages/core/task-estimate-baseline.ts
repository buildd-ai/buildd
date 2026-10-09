/**
 * The predictor the backtest scores everything against: today's neighbour
 * sizing from `./task-size-estimate.ts`, adapted to the `SizePredictor`
 * interface.
 *
 * The p50 of minutes is `estimateTaskSizeFromSessions` itself, so the baseline
 * cannot drift from what ships. The shipped estimate has no upper quantile and
 * no token figure, so the rest is read off the SAME k neighbours it chose: p80
 * is their linearly interpolated 80th percentile, tokens their median and
 * 80th percentile. With k = 5 the p80 is a thin estimate; that is the
 * baseline's honest resolution, not a tuned one.
 */
import type { PredictionContext, SizeEstimate, SizePredictor, TaskOutcome } from './task-estimate-backtest';
import { TASK_SIZE_NEIGHBOURS_K, estimateTaskSizeFromSessions, type NeighbourSession } from './task-size-estimate';

/** Neighbours with a token figure needed before the baseline answers for tokens. */
export const BASELINE_MIN_TOKEN_SAMPLES = 3;

export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function asSession(o: TaskOutcome): NeighbourSession {
  const started = o.minutes !== null ? new Date(o.completedAt.getTime() - o.minutes * 60_000) : null;
  return { taskId: o.taskId, filesChanged: o.filesChanged, startedAt: started, completedAt: o.completedAt };
}

export function neighbourMedianBaseline(opts: { k?: number } = {}): SizePredictor {
  const k = opts.k ?? TASK_SIZE_NEIGHBOURS_K;
  return {
    name: 'neighbour-median',
    predict(ctx: PredictionContext): SizeEstimate | null {
      const byId = new Map(ctx.history.map(h => [h.taskId, h]));
      const est = estimateTaskSizeFromSessions(ctx.neighbours, ctx.history.map(asSession), { k, cutoff: ctx.cutoff });
      if (!est) return null;

      // The same selection rule, to recover the neighbours behind `est`.
      const chosen: TaskOutcome[] = [];
      for (const id of ctx.neighbours) {
        const o = byId.get(id);
        if (!o || o.filesChanged === null || o.filesChanged < 0 || o.minutes === null || o.minutes <= 0) continue;
        chosen.push(o);
        if (chosen.length >= k) break;
      }
      const minutes = chosen.map(o => o.minutes!);
      const tokens = chosen.map(o => o.tokens).filter((t): t is number => t !== null && t > 0);
      return {
        // `est.minutes` is rounded to 0.1 by the shipped code; keep that figure for p50.
        minutes: { p50: est.minutes, p80: Math.max(est.minutes, quantile(minutes, 0.8)) },
        tokens: tokens.length >= BASELINE_MIN_TOKEN_SAMPLES
          ? { p50: quantile(tokens, 0.5), p80: quantile(tokens, 0.8) }
          : null,
      };
    },
  };
}
