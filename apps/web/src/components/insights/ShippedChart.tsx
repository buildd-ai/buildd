'use client';

/**
 * Tasks shipped (up) and lost (down) per day, with the same day of the window
 * before as a faint wider bar behind each. Counts sit outside the bars; when a
 * month makes the bars too narrow to label, the table below carries them.
 */
import { useEffect, useRef, useState } from 'react';
import type { DayBar } from './insights-summary';

const DEFAULT_W = 640;
const AXIS_FONT = 11;
/** Narrower than this, a count over a bar collides with its neighbour's. */
const LABEL_MIN_SLOT = 20;

export interface ShippedGeometry {
  plot: { left: number; right: number; top: number; bottom: number };
  zeroY: number;
  slot: number;
  bars: { x: number; label: string | null; shipped: Bar; lost: Bar; prevShipped: Bar | null; prevLost: Bar | null; shippedCount: number; lostCount: number }[];
  showCounts: boolean;
}
interface Bar { x: number; y: number; w: number; h: number }

/** Pure, so the layout is tested without a DOM. */
export function shippedGeometry(days: readonly DayBar[], width: number, height: number): ShippedGeometry {
  const plot = { left: 4, right: width - 4, top: 16, bottom: height - 20 };
  const n = Math.max(1, days.length);
  const slot = (plot.right - plot.left) / n;
  const maxUp = Math.max(1, ...days.map(d => Math.max(d.shipped, d.prevShipped ?? 0)));
  const maxDown = Math.max(0, ...days.map(d => Math.max(d.lost, d.prevLost ?? 0)));
  const h = plot.bottom - plot.top;
  // Lost work takes at most a third of the height, and none when nothing was lost.
  const downH = maxDown > 0 ? Math.min(h / 3, Math.max(h / 6, (h * maxDown) / (maxUp + maxDown))) : 0;
  const zeroY = plot.bottom - downH - (maxDown > 0 ? 14 : 0);
  const upUnit = (zeroY - plot.top) / maxUp;
  const downUnit = maxDown > 0 ? downH / maxDown : 0;
  const labelEvery = Math.max(1, Math.ceil(36 / slot));
  const up = (cx: number, w: number, v: number): Bar => ({ x: cx - w / 2, y: zeroY - v * upUnit, w, h: v * upUnit });
  const down = (cx: number, w: number, v: number): Bar => ({ x: cx - w / 2, y: zeroY + 1, w, h: v * downUnit });
  return {
    plot,
    zeroY,
    slot,
    showCounts: slot >= LABEL_MIN_SLOT,
    bars: days.map((d, i) => {
      const cx = plot.left + slot * (i + 0.5);
      const wide = Math.max(2, slot * 0.78);
      const narrow = Math.max(2, slot * 0.46);
      return {
        x: cx,
        // The newest day is always labelled; earlier ones every few slots when narrow.
        label: (days.length - 1 - i) % labelEvery === 0 ? d.label : null,
        shipped: up(cx, narrow, d.shipped),
        lost: down(cx, narrow, d.lost),
        prevShipped: d.prevShipped != null ? up(cx, wide, d.prevShipped) : null,
        prevLost: d.prevLost != null ? down(cx, wide, d.prevLost) : null,
        shippedCount: d.shipped,
        lostCount: d.lost,
      };
    }),
  };
}

export function ShippedChart({ days, previousLabel }: { days: readonly DayBar[]; previousLabel: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_W);
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
  const height = width < 480 ? 180 : 210;
  const geo = shippedGeometry(days, width, height);
  const hasPrev = days.some(d => d.prevShipped != null);
  const shipped = days.reduce((n, d) => n + d.shipped, 0);
  const lost = days.reduce((n, d) => n + d.lost, 0);

  return (
    <div data-testid="shipped-chart">
      <div ref={boxRef}>
        <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full" role="img"
          aria-label={`Tasks shipped and lost per day: ${shipped} shipped, ${lost} lost. The table below lists each day.`}>
          {geo.bars.map((b, i) => (
            <g key={i}>
              {b.prevShipped && <rect {...rect(b.prevShipped)} fill="var(--flow-released)" fillOpacity={0.18} />}
              {b.prevLost && <rect {...rect(b.prevLost)} fill="var(--flow-lost)" fillOpacity={0.18} />}
              <rect {...rect(b.shipped)} fill="var(--flow-released)" />
              <rect {...rect(b.lost)} fill="var(--flow-lost)" />
              {geo.showCounts && b.shippedCount > 0 && (
                <text x={b.x} y={b.shipped.y - 4} textAnchor="middle" fontSize={AXIS_FONT} className="fill-text-primary font-mono">{b.shippedCount}</text>
              )}
              {geo.showCounts && b.lostCount > 0 && (
                <text x={b.x} y={b.lost.y + b.lost.h + 11} textAnchor="middle" fontSize={AXIS_FONT} className="fill-text-secondary font-mono">{b.lostCount}</text>
              )}
              {b.label && <text x={b.x} y={height - 5} textAnchor="middle" fontSize={AXIS_FONT} className="fill-text-muted">{b.label}</text>}
            </g>
          ))}
          <line x1={geo.plot.left} x2={geo.plot.right} y1={geo.zeroY} y2={geo.zeroY} stroke="var(--border-strong)" strokeWidth={1} />
        </svg>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-text-secondary" data-testid="shipped-legend">
        <li className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 shrink-0" style={{ background: 'var(--flow-released)' }} />Shipped</li>
        <li className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 shrink-0" style={{ background: 'var(--flow-lost)' }} />Failed or abandoned</li>
        {hasPrev && <li className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 shrink-0" style={{ background: 'var(--flow-released)', opacity: 0.25 }} />{previousLabel}</li>}
      </ul>
      <details className="mt-3" data-testid="shipped-table">
        <summary className="cursor-pointer text-meta text-text-muted hover:text-text-secondary">Show as a table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-meta">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="py-1 pr-3 font-normal">Day</th>
                <th className="py-1 pr-3 text-right font-normal">Shipped</th>
                <th className="py-1 pr-3 text-right font-normal">Lost</th>
                {hasPrev && <th className="py-1 text-right font-normal">{previousLabel}</th>}
              </tr>
            </thead>
            <tbody className="font-mono">
              {days.map(d => (
                <tr key={d.start} className="border-t border-border-default">
                  <td className="whitespace-nowrap py-1 pr-3 font-sans text-text-secondary">{new Date(d.start + (d.end - d.start) / 2).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                  <td className="py-1 pr-3 text-right text-text-primary">{d.shipped}</td>
                  <td className="py-1 pr-3 text-right text-text-primary">{d.lost}</td>
                  {hasPrev && <td className="py-1 text-right text-text-muted">{d.prevShipped ?? ''}{d.prevShipped != null ? ` / ${d.prevLost ?? 0}` : ''}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

const rect = (b: Bar) => ({ x: b.x, y: b.y, width: b.w, height: Math.max(0, b.h) });
