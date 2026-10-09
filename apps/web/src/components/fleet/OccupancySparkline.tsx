/**
 * The last day's water level in one line: runner slots busy (time-weighted, per
 * 15 minutes) under a dotted ceiling at today's slot count, with interactive
 * sessions as a faint line of their own, never added to the slots. The ceiling
 * is labelled "now" because slot counts are not stored over time: it is not a
 * utilization line. Server-safe (no hooks), so Home renders it in the HTML.
 */
import Link from 'next/link';
import type { OccupancySeries } from '@/lib/fleet-occupancy';
import { fmtLevel, levelPaths, levelY, occupancyScaleMax } from './occupancy-geometry';

const W = 240;
const H = 28;

export function OccupancySparkline({ series, capacityNow, href }: { series: OccupancySeries; capacityNow: number; href?: string }) {
  const runner = series.buckets.map(b => b.runner.avg);
  const sessions = series.buckets.map(b => b.sessions.avg);
  const max = occupancyScaleMax(capacityNow, runner, sessions);
  const r = levelPaths(runner, max, W, H);
  const s = levelPaths(sessions, max, W, H);
  const hasSessions = series.summary.sessions.peak > 0;
  const { peak, avg } = series.summary.runner;
  const label = `Runner slots busy, last 24 hours: peak ${peak}, average ${fmtLevel(avg)}, of ${capacityNow} slots now`
    + (hasSessions ? `. Sessions peaked at ${series.summary.sessions.peak}.` : '.');

  const body = (
    <>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-7 w-full overflow-visible"
        role="img"
        aria-label={label}
      >
        {capacityNow > 0 && (
          <line
            data-testid="occupancy-ceiling"
            x1={0} x2={W} y1={levelY(capacityNow, max, H)} y2={levelY(capacityNow, max, H)}
            stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke"
          />
        )}
        <path d={r.area} fill="var(--accent-soft)" />
        <path d={r.line} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hasSessions && (
          <path data-testid="occupancy-sessions-line" d={s.line} fill="none" stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" opacity={0.7} />
        )}
      </svg>
      <span className="mt-1 flex min-w-0 justify-between gap-2 truncate font-mono text-[11px] text-text-muted">
        <span className="truncate">24h · peak {peak} · avg {fmtLevel(avg)} <span data-testid="occupancy-ceiling-label">of {capacityNow} now</span></span>
        {hasSessions && <span className="hidden shrink-0 md:inline">sessions peak {series.summary.sessions.peak}</span>}
      </span>
    </>
  );

  return (
    <div data-testid="occupancy-sparkline" className="mt-2 min-w-0">
      {href ? <Link href={href} className="block hover:opacity-80" aria-label={`${label} Open Runners & capacity.`}>{body}</Link> : body}
    </div>
  );
}
