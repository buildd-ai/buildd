'use client';

/**
 * Runners & capacity: runner slots in use over 24h, 7d or 30d.
 *
 * The scale comes from the data (`niceScaleMax`), not from capacity, so a peak
 * of one on a ten-slot fleet is still visible; slots online is stated as a
 * number, and drawn as a reference line only when it fits the scale. The area
 * is the time-weighted average per bucket, the thin line the peak in it.
 * Interactive sessions use no runner slot, so they get their own strip and
 * scale below rather than a line on the same axis. A window with no work says
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
const SESSIONS_H = 32;
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
        <h3 className="text-xs font-medium text-text-secondary">Runner slots in use</h3>
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
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.5px] text-text-muted">{label}</span>
      <span className="font-mono text-[18px] font-semibold leading-tight text-text-primary">{value}</span>
    </div>
  );
}

/** The chart for one loaded window; no fetching, so it renders in a test. */
export function OccupancyPlot({ series, capacityNow, busyNow }: { series: Loaded; capacityNow: number; busyNow: number }) {
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
  const avg = useMemo(() => series.buckets.map(b => b.runner.avg), [series]);
  const peak = useMemo(() => series.buckets.map(b => b.runner.peak), [series]);
  const sessions = useMemo(() => series.buckets.map(b => b.sessions.avg), [series]);
  const max = niceScaleMax(peak, avg);
  const sessionsMax = niceScaleMax(sessions);
  const runnerIdle = series.summary.runner.peak === 0;
  const hasSessions = series.summary.sessions.peak > 0;
  const capacityFits = capacityNow > 0 && capacityNow <= max;
  const n = series.buckets.length;
  const step = plotW / Math.max(1, n);
  const ticks = xTicks(series);
  const words = WINDOW_WORDS[series.windowKey];

  const metrics = (
    <div data-testid="occupancy-metrics" className="mb-4 flex flex-wrap gap-x-6 gap-y-2">
      <Metric label="Peak" value={String(series.summary.runner.peak)} />
      <Metric label="Average" value={fmtLevel(series.summary.runner.avg)} />
      <Metric label="In use now" value={String(busyNow)} />
      <Metric label="Slots online" value={String(capacityNow)} testId="occupancy-slots-online" />
    </div>
  );

  if (runnerIdle && !hasSessions) {
    return (
      <div ref={boxRef}>
        <p data-testid="occupancy-empty" className="py-2 text-body text-text-muted">No agents ran in the {words}.</p>
      </div>
    );
  }

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
    ? `${fmtBucket(b.t, series.windowKey)} · average ${fmtLevel(b.runner.avg)} · peak ${b.runner.peak}${hasSessions ? ` · sessions peak ${b.sessions.peak}` : ''}`
    : `Runner slots in use, ${words}`;

  const avgPaths = levelPaths(avg, max, plotW, PLOT_H);
  const peakPaths = levelPaths(peak, max, plotW, PLOT_H);
  const sessPaths = levelPaths(sessions, sessionsMax, plotW, SESSIONS_H);
  const sessionsTop = TOP + PLOT_H + AXIS_H + 10;
  const totalH = runnerIdle ? SESSIONS_H + 4 : hasSessions ? sessionsTop + SESSIONS_H + 4 : TOP + PLOT_H + AXIS_H;
  const crossX = hover != null ? hover * step + step / 2 : null;

  return (
    <div ref={boxRef}>
      {metrics}
      <p data-testid="occupancy-readout" className="mb-1 min-h-4 truncate font-mono text-[11px] text-text-muted md:text-[12px]" aria-live="polite">{readout}</p>
      {runnerIdle && <p data-testid="occupancy-runner-idle" className="py-2 text-body text-text-muted">No runner work in the {words}.</p>}
      <svg
        viewBox={`0 0 ${W} ${totalH}`}
        className="block h-auto w-full touch-pan-y select-none"
        role="img"
        aria-label={`Runner slots in use over the ${words}: peak ${series.summary.runner.peak}, average ${fmtLevel(series.summary.runner.avg)}; ${capacityNow} slots online now. Use left and right arrows to read each point.`}
        tabIndex={0}
        onPointerMove={e => setHover(indexAt(e))}
        onPointerDown={e => setHover(indexAt(e))}
        onPointerLeave={e => { if (e.pointerType !== 'touch') setHover(null); }}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {!runnerIdle && (
          <>
            {scaleTicks(max).map(v => (
              <g key={v}>
                <line x1={LEFT} x2={W - RIGHT} y1={TOP + levelY(v, max, PLOT_H)} y2={TOP + levelY(v, max, PLOT_H)} stroke="var(--border-default)" strokeWidth={1} />
                <text x={LEFT - 6} y={TOP + levelY(v, max, PLOT_H) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)">{v}</text>
              </g>
            ))}
            <g transform={`translate(${LEFT},${TOP})`}>
              <path d={avgPaths.area} fill="var(--accent-soft)" />
              <path d={avgPaths.line} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />
              {series.windowKey !== '24h' && (
                <path data-testid="occupancy-peak-line" d={peakPaths.line} fill="none" stroke="var(--accent-text)" strokeWidth={1} strokeLinejoin="round" opacity={0.55} />
              )}
              {capacityFits && (
                <g data-testid="occupancy-capacity-line">
                  <line x1={0} x2={plotW} y1={levelY(capacityNow, max, PLOT_H)} y2={levelY(capacityNow, max, PLOT_H)} stroke="var(--text-secondary)" strokeWidth={1} strokeDasharray="2 3" />
                  <text x={plotW - 2} y={levelY(capacityNow, max, PLOT_H) - 4} textAnchor="end" fontSize={11} fill="var(--text-secondary)">{capacityNow} slots online</text>
                </g>
              )}
              {crossX != null && <line x1={crossX} x2={crossX} y1={0} y2={PLOT_H} stroke="var(--text-primary)" strokeWidth={1} opacity={0.35} />}
              {ticks.map(t => (
                <text key={t.i} x={t.i * step + step / 2} y={PLOT_H + 15} textAnchor={tickAnchor(t.i * step + step / 2, plotW)} fontSize={11} fill="var(--text-muted)">{t.label}</text>
              ))}
            </g>
          </>
        )}
        {hasSessions && (
          <g data-testid="occupancy-sessions-strip" transform={`translate(${LEFT},${runnerIdle ? 0 : sessionsTop})`}>
            <text x={0} y={9} fontSize={11} fill="var(--text-muted)">Your sessions</text>
            <path d={sessPaths.line} fill="none" stroke="var(--text-muted)" strokeWidth={1.25} strokeLinejoin="round" />
            {crossX != null && <line x1={crossX} x2={crossX} y1={0} y2={SESSIONS_H} stroke="var(--text-primary)" strokeWidth={1} opacity={0.35} />}
          </g>
        )}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-text-muted">
        {!runnerIdle && <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 bg-accent" />Average in use</span>}
        {!runnerIdle && series.windowKey !== '24h' && <span className="flex items-center gap-1.5"><i className="inline-block h-0 w-3 border-t border-accent-text opacity-60" />Peak</span>}
        {capacityFits && !runnerIdle && <span className="flex items-center gap-1.5"><i className="inline-block h-0 w-3 border-t border-dotted border-text-secondary" />Slots online now</span>}
        {hasSessions && (
          <span data-testid="occupancy-sessions-label" className="flex items-center gap-1.5">
            <i className="inline-block h-0 w-3 border-t border-text-muted" />Your sessions, own scale · peak {series.summary.sessions.peak} · average {fmtLevel(series.summary.sessions.avg)}
          </span>
        )}
      </div>
      {series.truncated && <p className="mt-2 text-meta text-status-warning">Partial window: only the newest workers were read.</p>}
    </div>
  );
}
