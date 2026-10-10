/**
 * `?state=sample` for the Runners & capacity occupancy chart: a synthetic fleet
 * so the visual audit sees a populated chart when the CI QA account's team has
 * little history (docs/specs/qa-capture-steps.md). Dev server only. Built
 * through the real fold, so the sample can't drift from what live data renders.
 */
import { buildOccupancySeries, occupancyWindowMs, type OccupancySeries, type OccupancyWindow, type OccupancyWorkerRow } from '@/lib/fleet-occupancy';

const H = 3_600_000;

/** Deterministic pseudo-random so screenshots are stable run to run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function sampleOccupancySeries(window: OccupancyWindow, now = Date.now(), tzOffsetMs = 0): OccupancySeries {
  const r = rng(7);
  const span = occupancyWindowMs(window);
  const from = now - span;
  const workers: OccupancyWorkerRow[] = [];
  const count = Math.round(span / H) * 1.2;
  for (let n = 0; n < count; n++) {
    const start = from + r() * span;
    // Busier in the working day: drop most starts between 01:00 and 07:00 UTC.
    const hour = new Date(start).getUTCHours();
    if (hour >= 1 && hour < 7 && r() < 0.8) continue;
    const run = (0.2 + r() * 1.5) * H;
    const session = r() < 0.25;
    const live = start + run > now;
    workers.push({
      runner: session ? 'mcp' : 'http://sample-runner',
      status: live ? 'running' : 'completed',
      startedAt: start,
      completedAt: live ? null : start + run,
      updatedAt: null,
    });
  }
  return buildOccupancySeries({ window, now, workers, tzOffsetMs });
}

/** Whether the occupancy chart should draw the sample: `?state=sample` on a dev server. */
export function isOccupancySampleState(state: string | null, nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === 'development' && state === 'sample';
}
