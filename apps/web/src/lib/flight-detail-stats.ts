import type { MissionFlightStripData } from '@buildd/core/mission-helpers';

export interface FlightDetailStats {
  /** Idle-elided agent-time axis span — same figure the strip's own width encodes. */
  agentTimeMs: number;
  /** Sum of every elided idle gap (docs/design/mission-flight-strip.md's break glyphs), never drawn on the axis. */
  idleElidedMs: number;
  /** Count of BUILD -> CHECK -> BUILD runs in lane order. Null (not 0) when the mission has no
   * trustworthy lane data at all — a loop count over an uncaptioned track would be a fabricated read. */
  buildCheckLoops: number | null;
  /** Share of steering touches (human diamonds vs orchestrator cycles) that were human.
   * Null (not 0%) when there were no steering touches of either kind to take a share of. */
  humanPct: number | null;
}

/** Pure derivation over the already-computed flight-strip model — no new data source,
 * per the mission's discovery that the two competing core-model PRs (#2533/#2535) that would have
 * exposed these as first-class fields are unmerged; this reads only what computeMissionFlightStrip
 * (merged, PR #2534) already reports. */
export function computeFlightDetailStats(data: MissionFlightStripData): FlightDetailStats {
  const idleElidedMs = data.phases.reduce((sum, phase) => sum + phase.idleMs, 0);

  let buildCheckLoops: number | null = null;
  if (data.hasLaneData) {
    const orderedLanes = data.bars
      .filter(bar => !bar.dashed)
      .slice()
      .sort((a, b) => a.start - b.start)
      .map(bar => bar.lane);
    const runs: typeof orderedLanes = [];
    for (const lane of orderedLanes) {
      if (runs.length === 0 || runs[runs.length - 1] !== lane) runs.push(lane);
    }
    let loops = 0;
    for (let i = 0; i + 2 < runs.length; i++) {
      if (runs[i] === 'build' && runs[i + 1] === 'check' && runs[i + 2] === 'build') loops++;
    }
    buildCheckLoops = loops;
  }

  const humanTouches = data.rail.marks.filter(m => m.kind === 'human').length;
  const orchestratorCycles = data.rail.marks
    .filter(m => m.kind === 'orchestrator')
    .reduce((sum, m) => sum + m.count, 0);
  const totalTouches = humanTouches + orchestratorCycles;

  return {
    agentTimeMs: data.durationMs,
    idleElidedMs,
    buildCheckLoops,
    humanPct: totalTouches > 0 ? (humanTouches / totalTouches) * 100 : null,
  };
}

/** Plain-language one-liner for the sheet's prose row. Reads only rail marks + failure fill,
 * so it never claims an adjacency (e.g. "just before a new build") the model doesn't assert. */
export function describeSteeringPattern(data: MissionFlightStripData): string {
  const humanMarks = data.rail.marks.filter(m => m.kind === 'human');
  const failedCount = data.bars.filter(b => b.fill === 'failure').length;
  const failClause = failedCount > 0
    ? ` ${failedCount} build${failedCount === 1 ? '' : 's'} failed and ${failedCount === 1 ? 'was' : 'were'} retried.`
    : '';

  if (humanMarks.length === 0) {
    return data.rail.marks.length === 0
      ? `No steering recorded — the mission ran unattended.${failClause}`
      : `No human steering — the orchestrator ran the mission unattended.${failClause}`;
  }

  // A mark sitting exactly at the axis origin landed at mission start, not mid-flight.
  const midFlight = humanMarks.filter(m => m.position > 0).length;
  return `${midFlight} of ${humanMarks.length} human touch${humanMarks.length === 1 ? '' : 'es'} landed mid-flight.${failClause}`;
}

export function formatFlightDuration(ms: number): string {
  const min = ms / 60_000;
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
