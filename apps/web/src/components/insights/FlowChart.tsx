'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import Sheet from '@/components/ui/Sheet';
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

/** Drawn at the container's own pixel width, so axis text never scales below 11px on a phone. */
const DEFAULT_W = 640;
const heightFor = (w: number) => (w < 480 ? 220 : 260);
const AXIS_FONT = 11;
const BANDS: BandKey[] = [...STACK, 'lost'];

const fill = (k: BandKey) => `var(--flow-${k})`;

/** Which bucket the readout shows: hovered, else tapped, else the latest; none when empty. */
export function readoutIndex(hover: number | null, picked: number | null, last: number): number | null {
  if (last < 0) return null;
  return hover ?? picked ?? last;
}

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
  // Touch has no pointerleave: a tap picks a time instead of hovering one.
  const [detailOpen, setDetailOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [releaseIndex, setReleaseIndex] = useState<number | null>(null);
  const detailTrigger = useRef<HTMLButtonElement>(null);
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
    // The gap belongs to the strip below it: a tap just under the axis means lost work.
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
    const cur = hover ?? picked?.i ?? last;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const i = Math.max(0, Math.min(last, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
      setHover(i);
      setReleaseIndex(null);
      if (picked) setPicked({ ...picked, i });
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const b = series.buckets[cur];
      const band = [...BANDS].sort((x, y) => bandValue(b, y) - bandValue(b, x))[0];
      setReleaseIndex(null);
      setPicked({ i: cur, band });
    }
  };

  // The crosshair follows the pointer, or marks the picked time on touch.
  const markIndex = picked?.i ?? hover;
  const mb = markIndex != null ? series.buckets[markIndex] : null;
  const pickedTasks = picked ? tasksInBand(series, picked.i, picked.band) : [];
  const pickedBucket = picked ? series.buckets[picked.i] : null;
  const selectedX = pickedBucket ? (releaseIndex != null ? geo.releases[releaseIndex]?.x : geo.xOf((pickedBucket.start + pickedBucket.end) / 2)) ?? 0 : 0;
  const selectedY = picked && pickedBucket ? picked.band === 'lost'
    ? geo.lostTop + (geo.plot.bottom - geo.lostTop) * pickedBucket.lost / Math.max(1, geo.maxDown) / 2
    : geo.zeroY - (STACK.slice(0, STACK.indexOf(picked.band as typeof STACK[number])).reduce((n, k) => n + bandValue(pickedBucket, k), 0) + bandValue(pickedBucket, picked.band) / 2) * (geo.zeroY - geo.plot.top) / geo.maxUp
    : 0;
  const summaryY = releaseIndex != null ? geo.plot.top : selectedY;

  return (
    <div data-testid="flow-chart">
      <div className="relative" ref={boxRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full h-auto block touch-pan-y select-none"
          role="img"
          aria-label="Tasks by stage over time. Use left and right arrows to move, Enter to inspect."
          tabIndex={0}
          onPointerMove={e => {
            if (e.pointerType === 'touch') return;
            setHover(indexFromPointer(e));
          }}
          onPointerLeave={() => setHover(null)}
          onPointerDown={e => {
            const i = indexFromPointer(e);
            if (i < 0) return;
            const isTouch = e.pointerType === 'touch';
            setReleaseIndex(null);
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
                {Number(t.value.toFixed(2))}
              </text>
            </g>
          ))}
          {geo.lostTicks.filter(t => t.value > 0).map(t => (
            <g key={`lost-${t.value}`}>
              <line x1={geo.plot.left} x2={geo.plot.right} y1={t.y} y2={t.y} stroke="var(--border)" strokeWidth={1} />
              <text x={geo.plot.left - 6} y={t.y + 3} textAnchor="end" className="fill-text-muted" fontSize={AXIS_FONT} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {Number(t.value.toFixed(2))}
              </text>
            </g>
          ))}
          {geo.xTicks.map(t => (
            <text key={t.at} x={t.x} y={VIEW_H - 6} textAnchor="middle" className="fill-text-muted" fontSize={AXIS_FONT}>
              {t.label}
            </text>
          ))}

          {/* Bands, then a 2px surface separator along each top edge (the gap, not a stroke). */}
          {BANDS.map(k => geo.paths[k] && <path key={k} d={geo.paths[k]} fill={fill(k)} fillOpacity={k === 'released' ? 0.85 : k === 'waiting' || k === 'lost' ? 0.75 : 0.45} />)}
          {(['merged', 'waiting', 'released', 'lost'] as const).map(k => geo.edges[k] && <path key={`e-${k}`} d={geo.edges[k]} fill="none" stroke="var(--card)" strokeWidth={2} strokeLinejoin="round" />)}
          <line x1={geo.plot.left} x2={geo.plot.right} y1={geo.zeroY} y2={geo.zeroY} stroke="var(--border-strong)" strokeWidth={1} />
          {geo.maxDown > 0 && (
            <line x1={geo.plot.left} x2={geo.plot.right} y1={geo.lostTop} y2={geo.lostTop} stroke="var(--border-strong)" strokeWidth={1} />
          )}

          {/* Release ticks are annotations; only the selected event gets a hairline. */}
          {geo.releases.map((r, n) => (
            <g key={`${r.at}-${r.version}-${n}`} data-testid="flow-release" role="button" tabIndex={0}
              aria-label={`Release ${r.version ?? ''}, ${r.state}`}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => { setReleaseIndex(n); setPicked({ i: geo.bucketIndexAt(r.x), band: 'released' }); }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setReleaseIndex(n); setPicked({ i: geo.bucketIndexAt(r.x), band: 'released' }); } }}>
              <rect x={r.x - 11} y={0} width={22} height={26} fill="transparent" />
              <line x1={r.x} x2={r.x} y1={geo.plot.top} y2={geo.plot.top + 7}
                stroke={r.state === 'failed' ? 'var(--flow-lost)' : 'var(--text-muted)'} strokeWidth={releaseIndex === n ? 3 : 1.5} />
              {releaseIndex === n && <line data-testid="flow-release-line" x1={r.x} x2={r.x} y1={geo.plot.top} y2={geo.plot.bottom} stroke="var(--text-primary)" strokeWidth={1} />}
            </g>
          ))}

          {mb && releaseIndex == null && (
            <line data-testid="flow-selection" x1={geo.xOf((mb.start + mb.end) / 2)} x2={geo.xOf((mb.start + mb.end) / 2)} y1={geo.plot.top} y2={geo.plot.bottom} stroke="var(--text-primary)" strokeWidth={1} />
          )}
          {picked && releaseIndex == null && <circle cx={selectedX} cy={selectedY} r={4} fill={fill(picked.band)} stroke="var(--text-primary)" strokeWidth={2} />}
        </svg>
        {picked && pickedBucket && (
          <div data-testid="flow-summary" className="absolute z-10 border border-border-strong bg-surface-1 px-2 py-1 text-meta max-w-[220px]"
            style={{ left: Math.max(4, Math.min(VIEW_W - 224, selectedX - 110)), top: summaryY > VIEW_H / 2 ? Math.max(22, summaryY - 108) : Math.min(VIEW_H - 100, summaryY + 12) }} aria-live="polite">
            <div className="text-text-muted">{fmtWhen(releaseIndex != null ? geo.releases[releaseIndex].at : pickedBucket.start, series.bucketMs)}</div>
            <div className="font-semibold text-text-primary">{releaseIndex != null ? `Release ${geo.releases[releaseIndex].version ?? ''} · ${geo.releases[releaseIndex].state}` : `${BAND_LABEL[picked.band]} · ${fmtCount(bandValue(pickedBucket, picked.band))}`}</div>
            <button ref={detailTrigger} data-testid="flow-details-trigger" type="button" className="min-h-[44px] text-accent-text" onClick={() => { boxRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); setExpanded(false); setDetailOpen(true); }}>View tasks ({pickedTasks.length})</button>
          </div>
        )}
      </div>

      <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-meta text-text-secondary" data-testid="flow-legend">
        {([['released', 'Released'], ['running', 'In flight'], ['waiting', 'Needs input'], ['lost', 'Failed / abandoned']] as const).map(([k, label]) => (
          <li key={k} className="flex items-center gap-1.5"><span aria-hidden className="w-3 h-2 shrink-0" style={{ background: fill(k) }} />{label}</li>
        ))}
      </ul>
      <details className="mt-2 text-meta text-text-muted">
        <summary className="cursor-pointer min-h-[44px] flex items-center">About this chart</summary>
        <ul>{BANDS.map(k => <li key={k}>{BAND_LABEL[k]}: {BAND_HINT[k]}</li>)}</ul>
        <p>Ticks above the plot mark releases. Failed work uses a separate scale below zero.</p>
      </details>

      {/* The tapped band at the tapped time: the tasks behind the area. */}
      {picked && pickedBucket && (
        <Sheet open={detailOpen} onClose={() => setDetailOpen(false)} title={releaseIndex != null ? `Release ${geo.releases[releaseIndex]?.version ?? ''}` : BAND_LABEL[picked.band]}
          contextual height={expanded ? 'expanded' : 'peek'} testId="flow-picked" returnFocusRef={detailTrigger}
          handle={<button data-testid="flow-expand" type="button" className="w-full min-h-[44px] text-meta text-text-muted" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? 'Show less' : 'Expand details'}</button>}>
          <p className="text-meta text-text-muted">{fmtWhen(pickedBucket.start, series.bucketMs)}</p>
          <label className="mt-2 flex items-center gap-2 text-meta text-text-secondary">
            Stage
            <select aria-label="Stage" className="min-h-[44px] min-w-0 flex-1 bg-surface-2 text-text-primary px-2"
              value={picked.band} onChange={e => { setReleaseIndex(null); setPicked({ i: picked.i, band: e.target.value as BandKey }); }}>
              {BANDS.map(k => <option key={k} value={k}>{BAND_LABEL[k]}</option>)}
            </select>
          </label>
          {expanded && <p className="mt-2 text-meta text-text-muted">{BAND_HINT[picked.band]}</p>}
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
        </Sheet>
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
