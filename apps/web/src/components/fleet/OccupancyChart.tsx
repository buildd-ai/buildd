'use client';

/**
 * Runners & capacity: how many slots were busy over 24h, 7d or 30d. Runner
 * slots are the filled area (time-weighted per bucket); interactive sessions a
 * dashed line of their own; today's slot count a dotted reference labelled
 * "now", because past slot counts are not stored. Hover or arrow keys read one
 * bucket out, peak included, so a burst the average flattens is still visible.
 *
 * Fetches /api/fleet/occupancy itself, so switching window doesn't reload the
 * page. Every window on every plan.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { OCCUPANCY_WINDOWS, type OccupancySeries, type OccupancyWindow } from '@/lib/fleet-occupancy';
import { fmtLevel, levelPaths, levelY, occupancyScaleMax } from './occupancy-geometry';
import { isOccupancySampleState, sampleOccupancySeries } from './occupancy-sample';

const DEFAULT_W = 640;
const PLOT_H = 160;
const AXIS_H = 20;
const LEFT = 28;
/** Room above the top gridline for its label and the "slots now" label. */
const TOP = 16;
const RIGHT = 4;

type Loaded = OccupancySeries & { truncated?: boolean };

export function fmtBucket(t: number, window: OccupancyWindow): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (window === '24h') return time;
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${date}, ${time}`;
}

/** Tick positions (bucket indexes) and labels for the x axis: about five per window. */
export function xTicks(series: OccupancySeries): Array<{ i: number; label: string }> {
  const n = series.buckets.length;
  if (n === 0) return [];
  const every = series.windowKey === '24h' ? 24 : series.windowKey === '7d' ? 24 : 28; // 6h, 1d, 7d
  const out: Array<{ i: number; label: string }> = [];
  for (let i = n - 1; i >= 0; i -= every) {
    const d = new Date(series.buckets[i].t);
    const label = series.windowKey === '24h'
      ? d.toLocaleTimeString(undefined, { hour: 'numeric' })
      : d.toLocaleDateString(undefined, series.windowKey === '7d' ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
    out.unshift({ i, label });
  }
  return out;
}

/** Edge ticks hug the plot so their label is never cut off by the box. */
export function tickAnchor(x: number, plotW: number): 'start' | 'middle' | 'end' {
  if (x > plotW - 24) return 'end';
  if (x < 24) return 'start';
  return 'middle';
}

export function OccupancyChart({ capacityNow, workspaceId }: { capacityNow: number; workspaceId?: string | null }) {
  const searchParams = useSearchParams();
  const sample = isOccupancySampleState(searchParams?.get('state') ?? null);
  const [window, setWindow] = useState<OccupancyWindow>('24h');
  const [series, setSeries] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (sample) {
      setSeries(sampleOccupancySeries(window));
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    const qs = new URLSearchParams({ window });
    if (workspaceId) qs.set('workspace', workspaceId);
    fetch(`/api/fleet/occupancy?${qs}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: Loaded) => setSeries(s))
      .catch(err => { if (err?.name !== 'AbortError') setError(true); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [window, workspaceId, sample]);

  return (
    <div data-testid="health-section-occupancy" className="mb-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-xs font-medium text-text-secondary">Slots busy over time</h3>
        <div role="group" aria-label="Slots busy window" data-testid="occupancy-window-picker" className={`flex shrink-0 border-2 border-border-strong bg-surface-2 ${loading ? 'opacity-60' : ''}`}>
          {OCCUPANCY_WINDOWS.map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={window === value}
              onClick={() => setWindow(value)}
              className={`px-3 min-h-[44px] md:min-h-[28px] text-chip uppercase tracking-widest ${window === value ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      <div className="card p-4">
        {error ? (
          <p className="py-8 text-center text-body text-text-muted">Couldn&apos;t load this window.</p>
        ) : !series ? (
          <div className="h-[180px]" aria-busy="true" />
        ) : (
          <Plot series={series} capacityNow={capacityNow} />
        )}
      </div>
    </div>
  );
}

function Plot({ series, capacityNow }: { series: Loaded; capacityNow: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(1, W - LEFT - RIGHT);
  const runner = useMemo(() => series.buckets.map(b => b.runner.avg), [series]);
  const sessions = useMemo(() => series.buckets.map(b => b.sessions.avg), [series]);
  const max = occupancyScaleMax(capacityNow, runner, sessions);
  const r = levelPaths(runner, max, plotW, PLOT_H);
  const s = levelPaths(sessions, max, plotW, PLOT_H);
  const hasSessions = series.summary.sessions.peak > 0;
  const empty = series.summary.runner.peak === 0 && !hasSessions;
  const n = series.buckets.length;
  const step = plotW / Math.max(1, n);
  const ticks = xTicks(series);

  const indexAt = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W - LEFT;
    return Math.max(0, Math.min(n - 1, Math.floor(x / step)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = hover ?? n - 1;
    setHover(Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1))));
  };

  const b = hover != null ? series.buckets[hover] : null;
  const readout = b
    ? `${fmtBucket(b.t, series.windowKey)} · runner slots avg ${fmtLevel(b.runner.avg)}, peak ${b.runner.peak}${hasSessions ? ` · sessions avg ${fmtLevel(b.sessions.avg)}, peak ${b.sessions.peak}` : ''}`
    : `${series.windowKey} · runner slots peak ${series.summary.runner.peak}, avg ${fmtLevel(series.summary.runner.avg)}${hasSessions ? ` · sessions peak ${series.summary.sessions.peak}, avg ${fmtLevel(series.summary.sessions.avg)}` : ''}`;

  return (
    <div ref={boxRef}>
      <p data-testid="occupancy-readout" className="mb-2 min-h-4 truncate font-mono text-[11px] text-text-muted md:text-[12px]" aria-live="polite">{readout}</p>
      {empty && <p className="py-2 text-center text-body text-text-muted" data-testid="occupancy-empty">No agent work in this window.</p>}
      <svg
        viewBox={`0 0 ${W} ${TOP + PLOT_H + AXIS_H}`}
        className="block h-auto w-full touch-pan-y select-none"
        role="img"
        aria-label={`Runner slots busy over ${series.windowKey}: peak ${series.summary.runner.peak}, average ${fmtLevel(series.summary.runner.avg)}, of ${capacityNow} slots now. Use left and right arrows to read each point.`}
        tabIndex={0}
        onPointerMove={e => setHover(indexAt(e))}
        onPointerDown={e => setHover(indexAt(e))}
        onPointerLeave={e => { if (e.pointerType !== 'touch') setHover(null); }}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {[0, max / 2, max].map(v => (
          <g key={v}>
            <line x1={LEFT} x2={W - RIGHT} y1={TOP + levelY(v, max, PLOT_H)} y2={TOP + levelY(v, max, PLOT_H)} stroke="var(--border-default)" strokeWidth={1} />
            <text x={LEFT - 6} y={TOP + levelY(v, max, PLOT_H) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)">{fmtLevel(v)}</text>
          </g>
        ))}
        <g transform={`translate(${LEFT},${TOP})`}>
          <path d={r.area} fill="var(--accent-soft)" />
          <path d={r.line} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />
          {hasSessions && <path d={s.line} fill="none" stroke="var(--text-muted)" strokeWidth={1.25} strokeDasharray="4 3" />}
          {capacityNow > 0 && (
            <g data-testid="occupancy-capacity-now">
              <line x1={0} x2={plotW} y1={levelY(capacityNow, max, PLOT_H)} y2={levelY(capacityNow, max, PLOT_H)} stroke="var(--text-secondary)" strokeWidth={1} strokeDasharray="2 3" />
              <text x={plotW - 2} y={levelY(capacityNow, max, PLOT_H) - 4} textAnchor="end" fontSize={11} fill="var(--text-secondary)">{capacityNow} slots now</text>
            </g>
          )}
          {hover != null && <line x1={hover * step + step / 2} x2={hover * step + step / 2} y1={0} y2={PLOT_H} stroke="var(--text-primary)" strokeWidth={1} opacity={0.4} />}
          {ticks.map(t => (
            <text key={t.i} x={t.i * step + step / 2} y={PLOT_H + 15} textAnchor={tickAnchor(t.i * step + step / 2, plotW)} fontSize={11} fill="var(--text-muted)">{t.label}</text>
          ))}
        </g>
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-text-muted">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 bg-accent" />Runner slots (average)</span>
        {hasSessions && <span className="flex items-center gap-1.5"><i className="inline-block h-0 w-3 border-t border-dashed border-text-muted" />Your sessions</span>}
        {capacityNow > 0 && <span className="flex items-center gap-1.5"><i className="inline-block h-0 w-3 border-t border-dotted border-text-secondary" />Slots online now</span>}
      </div>
      {series.truncated && <p className="mt-2 text-meta text-status-warning">Partial window: only the newest workers were read.</p>}
    </div>
  );
}
