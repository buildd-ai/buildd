'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { FlowSeries } from '@/lib/insights-flow';
import {
  BAND_HINT,
  BAND_LABEL,
  STACK,
  bandValue,
  buildGeometry,
  tasksInBand,
  type BandKey,
} from './flow-chart-model';

/**
 * Stacked bands of a team's tasks by stage over time. Colours are chart-local
 * steps (`--flow-*` in globals.css) validated as a set for both themes: the
 * status tokens alone collide (orange beside yellow), so the bands use their
 * own steps while "waiting on you" keeps its emphasis through order, label and
 * the legend. Lost work hangs below the axis in the error colour.
 */

/** Drawn at the container's own pixel width, so axis text never scales below 11px on a phone. */
const DEFAULT_W = 640;
const heightFor = (w: number) => (w < 480 ? 220 : 260);
const AXIS_FONT = 11;
const BANDS: BandKey[] = [...STACK, 'lost'];

const fill = (k: BandKey) => `var(--flow-${k})`;

/** Whole numbers stay whole ("1", not "1.0"); only a value that rounds to less than 1 shows a decimal. */
export function fmtCount(v: number): string {
  if (v === 0) return '0';
  if (v < 0.95) return v.toFixed(1);
  return Math.round(v).toString();
}

function fmtWhen(t: number, bucketMs: number): string {
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (bucketMs >= 86_400_000) return date;
  return `${date}, ${d.toLocaleTimeString(undefined, { hour: 'numeric' })}`;
}

export function FlowChart({ series, taskHref }: { series: FlowSeries; taskHref: (key: string) => string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [VIEW_W, setWidth] = useState(DEFAULT_W);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const VIEW_H = heightFor(VIEW_W);
  const geo = useMemo(() => buildGeometry(series, VIEW_W, VIEW_H), [series, VIEW_W, VIEW_H]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Touch has no pointerleave, so a hover tooltip opened by a tap would stay on
  // top of the chart. On touch the picked panel below carries the same numbers.
  const [touch, setTouch] = useState(false);
  const [picked, setPicked] = useState<{ i: number; band: BandKey } | null>(null);
  const last = series.buckets.length - 1;

  const indexFromPointer = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return -1;
    const r = svg.getBoundingClientRect();
    return geo.bucketIndexAt(((e.clientX - r.left) / r.width) * VIEW_W);
  };

  /** Which band the pointer is over at bucket i (by height), else the biggest one. */
  const bandAt = (e: PointerEvent<SVGSVGElement>, i: number): BandKey => {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    const y = ((e.clientY - r.top) / r.height) * VIEW_H;
    const b = series.buckets[i];
    if (y > geo.zeroY) return 'lost';
    const unit = (geo.zeroY - geo.plot.top) / geo.maxUp;
    let acc = 0;
    for (const k of STACK) {
      acc += bandValue(b, k);
      if (y >= geo.zeroY - acc * unit) return k;
    }
    return STACK.reduce((best, k) => (bandValue(b, k) > bandValue(b, best) ? k : best), STACK[0]);
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (last < 0) return;
    const cur = hover ?? last;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(Math.max(0, cur - 1)); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setHover(Math.min(last, cur + 1)); }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const b = series.buckets[cur];
      const band = [...BANDS].sort((x, y) => bandValue(b, y) - bandValue(b, x))[0];
      setPicked({ i: cur, band });
    }
  };

  const hb = hover != null ? series.buckets[hover] : null;
  // The crosshair follows the pointer, or marks the picked time on touch.
  const markIndex = hover ?? (touch && picked ? picked.i : null);
  const mb = markIndex != null ? series.buckets[markIndex] : null;
  const pickedTasks = picked ? tasksInBand(series, picked.i, picked.band) : [];
  const pickedBucket = picked ? series.buckets[picked.i] : null;

  return (
    <div data-testid="flow-chart">
      <div className="relative" ref={boxRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full h-auto block touch-none select-none"
          role="img"
          aria-label="Tasks by stage over time. Use left and right arrows to move, Enter to list the tasks."
          tabIndex={0}
          onPointerMove={e => {
            if (e.pointerType === 'touch') return;
            setTouch(false);
            setHover(indexFromPointer(e));
          }}
          onPointerLeave={() => setHover(null)}
          onPointerDown={e => {
            const i = indexFromPointer(e);
            if (i < 0) return;
            const isTouch = e.pointerType === 'touch';
            setTouch(isTouch);
            setHover(isTouch ? null : i);
            setPicked({ i, band: bandAt(e, i) });
          }}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {/* Grid: solid hairlines, recessive. */}
          {geo.yTicks.map(t => (
            <g key={t.value}>
              <line x1={geo.plot.left} x2={geo.plot.right} y1={t.y} y2={t.y} stroke="var(--border)" strokeWidth={1} />
              <text x={geo.plot.left - 6} y={t.y + 3} textAnchor="end" className="fill-text-muted" fontSize={AXIS_FONT} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {Number(Math.abs(t.value).toFixed(2))}
              </text>
            </g>
          ))}
          {geo.xTicks.map(t => (
            <text key={t.at} x={t.x} y={VIEW_H - 6} textAnchor="middle" className="fill-text-muted" fontSize={AXIS_FONT}>
              {t.label}
            </text>
          ))}

          {/* Bands, then a 2px surface separator along each top edge (the gap, not a stroke). */}
          {BANDS.map(k => geo.paths[k] && <path key={k} d={geo.paths[k]} fill={fill(k)} fillOpacity={k === 'released' ? 0.55 : 0.85} />)}
          {BANDS.map(k => geo.edges[k] && <path key={`e-${k}`} d={geo.edges[k]} fill="none" stroke="var(--card)" strokeWidth={2} strokeLinejoin="round" />)}
          <line x1={geo.plot.left} x2={geo.plot.right} y1={geo.zeroY} y2={geo.zeroY} stroke="var(--border-strong)" strokeWidth={1} />

          {/* Releases: a hairline and a tick at the top. */}
          {geo.releases.map(r => (
            <g key={`${r.at}-${r.version}`} aria-hidden>
              <line x1={r.x} x2={r.x} y1={geo.plot.top} y2={geo.plot.bottom} stroke="var(--text-muted)" strokeWidth={1} strokeOpacity={r.shipped ? 0.8 : 0.35} />
              <rect x={r.x - 3} y={geo.plot.top - 1} width={6} height={6} fill={r.shipped ? 'var(--flow-released)' : 'var(--flow-lost)'} />
            </g>
          ))}

          {mb && (
            <line x1={geo.xOf((mb.start + mb.end) / 2)} x2={geo.xOf((mb.start + mb.end) / 2)} y1={geo.plot.top} y2={geo.plot.bottom} stroke="var(--text-primary)" strokeWidth={1} />
          )}
        </svg>

        {hover != null && hb && !touch && (
          <div
            data-testid="flow-tooltip"
            className="pointer-events-none absolute top-1 z-10 border-2 border-border-strong bg-surface-2 px-3 py-2 text-meta shadow-md min-w-[11rem]"
            style={hover > series.buckets.length / 2 ? { right: '0.25rem' } : { left: '2.5rem' }}
          >
            <div className="text-text-muted mb-1">{fmtWhen(hb.start, series.bucketMs)}</div>
            {[...BANDS].reverse().map(k => (
              <div key={k} className="flex items-center gap-2">
                <span aria-hidden className="inline-block w-3 h-0.5" style={{ background: fill(k) }} />
                <span className="font-semibold text-text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCount(bandValue(hb, k))}</span>
                <span className="text-text-secondary">{BAND_LABEL[k]}</span>
              </div>
            ))}
            {Object.keys(hb.running).length > 0 && (
              <div className="mt-1 pt-1 border-t border-border-default text-text-muted">
                {Object.entries(hb.running).sort((a, b) => b[1] - a[1]).map(([role, v]) => `${role} ${fmtCount(v)}`).join(' · ')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend: always present, swatch beside text-token labels. */}
      <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5" data-testid="flow-legend">
        {BANDS.map(k => (
          <li key={k} className="flex items-start gap-2 text-meta">
            <span aria-hidden className="mt-1 inline-block w-3 h-3 shrink-0" style={{ background: fill(k), opacity: k === 'released' ? 0.55 : 0.85 }} />
            <span>
              <span className={k === 'waiting' ? 'font-semibold text-text-primary' : 'text-text-secondary'}>{BAND_LABEL[k]}</span>
              <span className="text-text-muted"> · {BAND_HINT[k]}</span>
            </span>
          </li>
        ))}
      </ul>

      {/* The tapped band at the tapped time: the tasks behind the area. */}
      {picked && pickedBucket && (
        <section className="mt-4 border-2 border-border-strong bg-surface-2 p-3" data-testid="flow-picked" aria-live="polite">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-title font-semibold">
              {BAND_LABEL[picked.band]} <span className="font-normal text-text-muted">· {fmtWhen(pickedBucket.start, series.bucketMs)}</span>
            </h3>
            <button type="button" className="btn btn-sm shrink-0" onClick={() => setPicked(null)}>Close</button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Stage">
            {BANDS.map(k => (
              <button
                key={k}
                type="button"
                aria-pressed={picked.band === k}
                onClick={() => setPicked({ i: picked.i, band: k })}
                className={`px-2 min-h-[32px] border border-border-strong text-chip uppercase tracking-wider ${picked.band === k ? 'bg-surface-3 text-text-primary' : 'text-text-muted'}`}
              >
                {BAND_LABEL[k]}
              </button>
            ))}
          </div>
          {pickedTasks.length === 0 ? (
            <p className="mt-3 text-body text-text-muted">No tasks in this stage then.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border-default">
              {pickedTasks.slice(0, 25).map(t => (
                <li key={t.key} className="py-2">
                  <a href={taskHref(t.key)} className="block min-h-[44px] md:min-h-0 text-body text-text-primary hover:text-accent-text">
                    {t.title}
                    <span className="block text-meta text-text-muted">{t.role}</span>
                  </a>
                </li>
              ))}
              {pickedTasks.length > 25 && <li className="py-2 text-meta text-text-muted">and {pickedTasks.length - 25} more</li>}
            </ul>
          )}
        </section>
      )}

      {/* Table view: the same numbers without the chart, per day. */}
      <details className="mt-4" data-testid="flow-table">
        <summary className="cursor-pointer text-meta text-text-muted hover:text-text-secondary">Show as a table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-meta" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr className="text-text-muted text-left">
                <th className="py-1 pr-3 font-normal">Day</th>
                {BANDS.map(k => <th key={k} className="py-1 pr-3 font-normal text-right">{BAND_LABEL[k]}</th>)}
              </tr>
            </thead>
            <tbody>
              {dailyRows(series).map(r => (
                <tr key={r.day} className="border-t border-border-default">
                  <td className="py-1 pr-3 text-text-secondary whitespace-nowrap">{r.label}</td>
                  {BANDS.map(k => <td key={k} className="py-1 pr-3 text-right text-text-primary">{fmtCount(r.values[k])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-meta text-text-muted">Work stages are the day's average; released and failed are running totals at the end of the day.</p>
        </div>
      </details>
    </div>
  );
}

/** Per-day rows for the table: average for work stages, end-of-day value for running totals. */
export function dailyRows(series: FlowSeries): { day: number; label: string; values: Record<BandKey, number> }[] {
  const days = new Map<number, typeof series.buckets>();
  for (const b of series.buckets) {
    const d = new Date(b.start);
    d.setHours(0, 0, 0, 0);
    const k = d.getTime();
    if (!days.has(k)) days.set(k, []);
    days.get(k)!.push(b);
  }
  return [...days].map(([day, bs]) => {
    const values = {} as Record<BandKey, number>;
    for (const k of BANDS) {
      values[k] = k === 'released' || k === 'lost'
        ? bandValue(bs[bs.length - 1], k)
        : bs.reduce((s, b) => s + bandValue(b, k), 0) / bs.length;
    }
    return { day, label: new Date(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), values };
  });
}
