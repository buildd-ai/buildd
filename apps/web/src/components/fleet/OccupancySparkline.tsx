/**
 * The last day's runner slots in use, as one quiet line: time-weighted per 15
 * minutes, scaled to its own highest point so a quiet day still shows its shape
 * (capacity never sets the scale; the tile states it in words). A day with no
 * runner work says so instead of drawing a flat line. Server-safe (no hooks),
 * so Home renders it in the HTML.
 */
import Link from 'next/link';
import type { OccupancySeries } from '@/lib/fleet-occupancy';
import { fmtLevel, levelPaths, niceScaleMax } from './occupancy-geometry';

const W = 240;
const H = 24;

/** "Past 24h · Peak 10 · Avg 1.7": what the line says, in words. */
export function sparklineCaption(series: OccupancySeries): string {
  const { peak, avg } = series.summary.runner;
  return `Past 24h · Peak ${peak} · Avg ${fmtLevel(avg)}`;
}

/** A stretch of the window to tint flat (idle while work waited). */
export interface SparklineShade { from: number; to: number }

export function OccupancySparkline({ series, href, shade = [] }: { series: OccupancySeries; href?: string; shade?: readonly SparklineShade[] }) {
  const span = series.window.to - series.window.from;
  const x = (t: number) => Math.round((Math.min(Math.max(t, series.window.from), series.window.to) - series.window.from) / span * W * 100) / 100;
  const values = series.buckets.map(b => b.runner.avg);
  const idle = series.summary.runner.peak === 0;
  const { line, area } = levelPaths(values, niceScaleMax(values), W, H);
  const caption = idle ? 'No runner work in the past 24h' : sparklineCaption(series);
  const label = idle
    ? 'No runner work in the past 24 hours.'
    : `Runner slots in use over the past 24 hours: peak ${series.summary.runner.peak}, average ${fmtLevel(series.summary.runner.avg)}.`;

  const body = (
    <>
      {(!idle || shade.length > 0) && (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-6 w-full" role="img" aria-label={label}>
          {span > 0 && shade.map((r, i) => (
            <rect key={i} data-testid="occupancy-shade" x={x(r.from)} y={0} width={Math.max(1, x(r.to) - x(r.from))} height={H} fill="var(--q-tint)" />
          ))}
          <path d={area} fill="var(--accent-soft)" opacity={0.6} />
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.25} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
      )}
      <span data-testid="occupancy-caption" className="mt-1 block truncate font-mono text-[11px] text-text-muted">{caption}</span>
    </>
  );

  return (
    <div data-testid="occupancy-sparkline" className="mt-2 min-w-0">
      {href ? <Link href={href} className="block hover:opacity-80" aria-label={`${label} Open Runners & capacity.`}>{body}</Link> : body}
    </div>
  );
}
