'use client';

/**
 * Runners & capacity: runner slots in use over 24h, 7d or 30d.
 *
 * The scale comes from the data (`niceScaleMax`), not from capacity, so a peak
 * of one on a ten-slot fleet is still visible; slots online is stated as a
 * number, and drawn as a reference line only when it fits the scale. The area
 * is the time-weighted average per bucket, the thin line the peak in it.
 * Interactive sessions use no runner slot, so they are a separate chart below,
 * with their own numbers, never a line on the runner axis. A window with no work says
 * so in one line instead of drawing zeros.
 *
 * Fetches /api/fleet/occupancy itself, so switching window doesn't reload the
 * page. Every window on every plan.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { OCCUPANCY_WINDOWS, type OccupancySeries, type OccupancyWindow } from '@/lib/fleet-occupancy';
import { fmtLevel, levelPaths, levelY, niceScaleMax, scaleTicks } from './occupancy-geometry';
import { isOccupancySampleState, sampleOccupancySeries } from './occupancy-sample';

const DEFAULT_W = 640;
const PLOT_H = 140;
const SESSIONS_H = 64;
const AXIS_H = 20;
const LEFT = 24;
/** Room above the top gridline for its label and the "slots online" label. */
const TOP = 14;
const RIGHT = 4;

type Loaded = OccupancySeries & { truncated?: boolean };

const WINDOW_WORDS: Record<OccupancyWindow, string> = { '24h': 'past 24 hours', '7d': 'past 7 days', '30d': 'past 30 days' };

export function fmtBucket(t: number, window: OccupancyWindow): string {
  const d = new Date(t);
  if (window === '30d') return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (window === '24h') return time;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** Tick positions (bucket indexes) and labels for the x axis: about five per window. */
export function xTicks(series: OccupancySeries): Array<{ i: number; label: string }> {
  const n = series.buckets.length;
  if (n === 0) return [];
  const every = series.windowKey === '24h' ? 24 : series.windowKey === '7d' ? 24 : 7; // 6h, 1d, 1w
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

export function OccupancyChart({ capacityNow, busyNow, workspaceId }: { capacityNow: number; busyNow: number; workspaceId?: string | null }) {
  const searchParams = useSearchParams();
  const sample = isOccupancySampleState(searchParams?.get('state') ?? null);
  const [window, setWindow] = useState<OccupancyWindow>('24h');
  const [series, setSeries] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const tzOffset = -new Date().getTimezoneOffset();
    if (sample) {
      setSeries(sampleOccupancySeries(window, Date.now(), tzOffset * 60_000));
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    const qs = new URLSearchParams({ window, tzOffset: String(tzOffset) });
    if (workspaceId) qs.set('workspace', workspaceId);
    fetch(`/api/fleet/occupancy?${qs}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: Loaded) => setSeries(s))
      .catch(err => { if (err?.name !== 'AbortError') setError(true); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [window, workspaceId, sample]);

  return (
    <div data-testid="health-section-occupancy" className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-text-secondary">Runner slots</h3>
        <div role="group" aria-label="Slots busy window" data-testid="occupancy-window-picker" className={`flex shrink-0 border border-border-default ${loading ? 'opacity-60' : ''}`}>
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
      {error ? (
        <p className="py-6 text-body text-text-muted">Couldn&apos;t load this window.</p>
      ) : !series ? (
        <div className="h-[220px]" aria-busy="true" />
      ) : (
        <OccupancyPlot series={series} capacityNow={capacityNow} busyNow={busyNow} />
      )}
    </div>
  );
}

function Metric({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col">
      <span className="font-mono text-[11px] md:text-[10px] font-semibold uppercase tracking-[1.5px] text-text-muted">{label}</span>
      <span className="font-mono text-[18px] font-semibold leading-tight text-text-primary">{value}</span>
    </div>
  );
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * One series over the window: average as a filled area, optionally the peak as
 * a thin line and slots online as a dotted reference. Hover is shared, so the
 * runner and session charts point at the same time.
 */
function LevelChart({ series, avg, peak, height, capacity, hover, setHover, label, tone }: {
  series: OccupancySeries;
  avg: number[];
  peak: number[] | null;
  height: number;
  capacity: number | null;
  hover: number | null;
  setHover: (i: number | null) => void;
  label: string;
  tone: 'accent' | 'muted';
}) {
  const [ref, W] = useWidth();
  const plotW = Math.max(1, W - LEFT - RIGHT);
  const max = niceScaleMax(peak ?? avg, avg);
  const n = series.buckets.length;
  const step = plotW / Math.max(1, n);
  const ticks = xTicks(series);
  const a = levelPaths(avg, max, plotW, height);
  const p = peak ? levelPaths(peak, max, plotW, height) : null;
  const capacityFits = capacity != null && capacity > 0 && capacity <= max;
  const crossX = hover != null ? hover * step + step / 2 : null;
  const stroke = tone === 'accent' ? 'var(--accent)' : 'var(--text-secondary)';
  const fill = tone === 'accent' ? 'var(--accent-soft)' : 'var(--surface-3)';

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

  return (
    <div ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${TOP + height + AXIS_H}`}
        className="block h-auto w-full touch-pan-y select-none"
        role="img"
        aria-label={`${label} Use left and right arrows to read each point.`}
        tabIndex={0}
        onPointerMove={e => setHover(indexAt(e))}
        onPointerDown={e => setHover(indexAt(e))}
        onPointerLeave={e => { if (e.pointerType !== 'touch') setHover(null); }}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {scaleTicks(max).map(v => (
          <g key={v}>
            <line x1={LEFT} x2={W - RIGHT} y1={TOP + levelY(v, max, height)} y2={TOP + levelY(v, max, height)} stroke="var(--border-default)" strokeWidth={1} />
            <text x={LEFT - 6} y={TOP + levelY(v, max, height) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)">{v}</text>
          </g>
        ))}
        <g transform={`translate(${LEFT},${TOP})`}>
          <path d={a.area} fill={fill} />
          <path d={a.line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
          {p && <path data-testid="occupancy-peak-line" d={p.line} fill="none" stroke={tone === 'accent' ? 'var(--accent-text)' : 'var(--text-muted)'} strokeWidth={1} strokeLinejoin="round" opacity={0.55} />}
          {capacityFits && (
            <g data-testid="occupancy-capacity-line">
              <line x1={0} x2={plotW} y1={levelY(capacity!, max, height)} y2={levelY(capacity!, max, height)} stroke="var(--text-secondary)" strokeWidth={1} strokeDasharray="2 3" />
              <text x={plotW - 2} y={levelY(capacity!, max, height) - 4} textAnchor="end" fontSize={11} fill="var(--text-secondary)">{capacity} slots online</text>
            </g>
          )}
          {crossX != null && <line x1={crossX} x2={crossX} y1={0} y2={height} stroke="var(--text-primary)" strokeWidth={1} opacity={0.35} />}
          {ticks.map(t => (
            <text key={t.i} x={t.i * step + step / 2} y={height + 15} textAnchor={tickAnchor(t.i * step + step / 2, plotW)} fontSize={11} fill="var(--text-muted)">{t.label}</text>
          ))}
        </g>
      </svg>
    </div>
  );
}

/** The charts for one loaded window; no fetching, so it renders in a test. */
export function OccupancyPlot({ series, capacityNow, busyNow }: { series: Loaded; capacityNow: number; busyNow: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const avg = useMemo(() => series.buckets.map(b => b.runner.avg), [series]);
  const peak = useMemo(() => series.buckets.map(b => b.runner.peak), [series]);
  const sessAvg = useMemo(() => series.buckets.map(b => b.sessions.avg), [series]);
  const sessPeak = useMemo(() => series.buckets.map(b => b.sessions.peak), [series]);
  const runnerIdle = series.summary.runner.peak === 0;
  const hasSessions = series.summary.sessions.peak > 0;
  const words = WINDOW_WORDS[series.windowKey];
  const showPeak = series.windowKey !== '24h';

  if (runnerIdle && !hasSessions) {
    return <p data-testid="occupancy-empty" className="py-2 text-body text-text-muted">No agents ran in the {words}.</p>;
  }

  const b = hover != null ? series.buckets[hover] : null;
  const readout = (kind: 'runner' | 'sessions') => b
    ? `${fmtBucket(b.t, series.windowKey)}: average ${fmtLevel(b[kind].avg)}, peak ${b[kind].peak}`
    : '';

  return (
    <div>
      <div data-testid="occupancy-metrics" className="mb-3 flex flex-wrap gap-x-6 gap-y-2">
        <Metric label="Peak" value={String(series.summary.runner.peak)} />
        <Metric label="Average" value={fmtLevel(series.summary.runner.avg)} />
        <Metric label="In use now" value={String(busyNow)} />
        <Metric label="Slots online" value={String(capacityNow)} testId="occupancy-slots-online" />
      </div>
      {runnerIdle ? (
        <p data-testid="occupancy-runner-idle" className="py-2 text-body text-text-muted">No runner work in the {words}.</p>
      ) : (
        <>
          <p data-testid="occupancy-readout" className="min-h-4 truncate font-mono text-[11px] text-text-muted md:text-[12px]" aria-live="polite">{readout('runner')}</p>
          <LevelChart
            series={series} avg={avg} peak={showPeak ? peak : null} height={PLOT_H} capacity={capacityNow}
            hover={hover} setHover={setHover} tone="accent"
            label={`Runner slots in use over the ${words}: peak ${series.summary.runner.peak}, average ${fmtLevel(series.summary.runner.avg)}.`}
          />
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-text-muted">
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 bg-accent" />Average</span>
            {showPeak && <span className="flex items-center gap-1.5"><i className="inline-block h-0 w-3 border-t border-accent-text opacity-60" />Peak</span>}
          </div>
        </>
      )}

      {hasSessions && (
        <div data-testid="occupancy-sessions" className="mt-8">
          <h3 className="mb-3 text-xs font-medium text-text-secondary">Interactive sessions</h3>
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2">
            <Metric label="Peak" value={String(series.summary.sessions.peak)} />
            <Metric label="Average" value={fmtLevel(series.summary.sessions.avg)} />
          </div>
          <p className="min-h-4 truncate font-mono text-[11px] text-text-muted md:text-[12px]">{readout('sessions')}</p>
          <LevelChart
            series={series} avg={sessAvg} peak={showPeak ? sessPeak : null} height={SESSIONS_H} capacity={null}
            hover={hover} setHover={setHover} tone="muted"
            label={`Interactive sessions over the ${words}: peak ${series.summary.sessions.peak}, average ${fmtLevel(series.summary.sessions.avg)}.`}
          />
        </div>
      )}
      {series.truncated && <p className="mt-2 text-meta text-status-warning">Partial window: only the newest workers were read.</p>}
    </div>
  );
}
