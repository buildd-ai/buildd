'use client';

import { useId } from 'react';
import type { MissionFlightStripData, FlightStripBar, WorkLane } from '@buildd/core/mission-helpers';

// ─── Encoding tokens (normative per docs/design/mission-flight-strip.md and the
// design boards design:flight-strip/missions-list, mission-detail, flight-detail-sheet) ───

export const FLIGHT_STRIP_CONCURRENCY_FILL: Record<1 | 2 | 3, string> = {
  1: '#4f8a6b',
  2: '#8fd9b0',
  3: '#c4f2d8',
};
export const FLIGHT_STRIP_FAILURE_FILL = '#d2584b';
export const FLIGHT_STRIP_NOW_COLOR = '#f0a05a';
export const FLIGHT_STRIP_HUMAN_COLOR = '#e0873a';
export const FLIGHT_STRIP_ORCHESTRATOR_STROKE = '#9a9488';
export const FLIGHT_STRIP_QUEUED_STROKE = '#6f6a60';
export const FLIGHT_STRIP_DIVIDER_STROKE = '#4a4740';
export const FLIGHT_STRIP_TRACK_BG = '#2a2926';
export const FLIGHT_STRIP_LABEL_COLOR = '#9a9488';

const LANE_LABEL: Record<WorkLane, string> = { think: 'THINK', build: 'BUILD', check: 'CHECK' };
const LANE_ORDER: WorkLane[] = ['think', 'build', 'check'];

// ─── Geometry constants — every magic number here is named, not a literal in the JSX ───

const LABEL_W = 42;
const RIGHT_PAD = 4;
const ROW_H = 10;
const ROW_GAP = 4;
const ROW_PITCH = ROW_H + ROW_GAP;
const RAIL_H = 12;
const RAIL_GAP = 2;
const BASELINE_GAP = 2;
const PHASE_LABEL_H = 12;
const MIN_BAR_W = 2;
const QUEUED_GLYPH_W = 20;
const QUEUED_GLYPH_GAP = 3;
/** Rule X-5: a lane rendering more than this many segments folds the tail into one hatched block. */
export const FLIGHT_STRIP_LANE_FOLD_CAP = 12;

function formatDuration(min: number): string {
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

type LaneKey = WorkLane | 'unclassified' | 'unlabelled';

function laneRows(data: MissionFlightStripData): Array<{ key: LaneKey; label: string | null }> {
  if (!data.hasLaneData) return [{ key: 'unlabelled', label: null }];
  const rows: Array<{ key: LaneKey; label: string | null }> = LANE_ORDER.map(lane => ({
    key: lane,
    label: LANE_LABEL[lane],
  }));
  if (data.bars.some(b => b.lane === null)) rows.push({ key: 'unclassified', label: 'UNCLASSIFIED' });
  return rows;
}

function barLaneKey(bar: FlightStripBar, hasLaneData: boolean): LaneKey {
  if (!hasLaneData) return 'unlabelled';
  return bar.lane ?? 'unclassified';
}

interface LayoutRect {
  bar: FlightStripBar;
  x: number;
  width: number;
}

function layoutLaneBars(bars: FlightStripBar[], workX: number, workW: number): { rects: LayoutRect[]; folded: number } {
  const real = bars.filter(b => !b.dashed);
  const queued = bars.filter(b => b.dashed);

  const realRects: LayoutRect[] = real.map(bar => {
    const x1 = workX + bar.start * workW;
    const x2 = workX + bar.end * workW;
    return { bar, x: x1, width: Math.max(MIN_BAR_W, x2 - x1) };
  });

  let folded = 0;
  let visibleReal = realRects;
  if (realRects.length > FLIGHT_STRIP_LANE_FOLD_CAP) {
    folded = realRects.length - FLIGHT_STRIP_LANE_FOLD_CAP;
    visibleReal = realRects.slice(0, FLIGHT_STRIP_LANE_FOLD_CAP);
  }

  const queuedRects: LayoutRect[] = queued.map((bar, i) => {
    const anchorX = workX + bar.start * workW;
    return { bar, x: anchorX + i * (QUEUED_GLYPH_W + QUEUED_GLYPH_GAP), width: QUEUED_GLYPH_W };
  });

  return { rects: [...visibleReal, ...queuedRects], folded };
}

function fillFor(bar: FlightStripBar): string | null {
  if (bar.fill === 'failure') return FLIGHT_STRIP_FAILURE_FILL;
  if (bar.fill === 'concurrency') return FLIGHT_STRIP_CONCURRENCY_FILL[Math.max(1, bar.concurrency) as 1 | 2 | 3];
  return null;
}

function diamondPath(cx: number, cy: number, r: number): string {
  return `M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`;
}

export interface FlightStripProps {
  data: MissionFlightStripData;
  /** viewBox width in px; height is derived from lane/rail count. */
  width?: number;
  className?: string;
}

/** Pure SVG renderer for MissionFlightStripData (packages/core/mission-helpers.ts).
 * No data fetching — callers compute the model and pass it in. Replaces MissionSkylineChart. */
export function FlightStrip({ data, width = 322, className }: FlightStripProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const rows = laneRows(data);
  const showRail = data.rail.visible;
  const railTop = 0;
  const railBottom = showRail ? RAIL_H : 0;
  const tracksTop = railBottom + (showRail ? RAIL_GAP : 0);
  const baseline = tracksTop + rows.length * ROW_PITCH - ROW_GAP + BASELINE_GAP;
  const height = baseline + PHASE_LABEL_H;

  const workX = LABEL_W;
  const workW = Math.max(1, width - LABEL_W - RIGHT_PAD);
  const position = (p: number) => workX + p * workW;

  const rowY = new Map<LaneKey, number>();
  rows.forEach((row, i) => rowY.set(row.key, tracksTop + i * ROW_PITCH));

  const barsByLane = new Map<LaneKey, FlightStripBar[]>();
  for (const bar of data.bars) {
    const key = barLaneKey(bar, data.hasLaneData);
    if (!barsByLane.has(key)) barsByLane.set(key, []);
    barsByLane.get(key)!.push(bar);
  }

  const activeBarCount = data.bars.filter(b => !b.dashed).length;
  const ariaLabel = [
    data.hasLaneData ? 'Flight strip' : 'Flight strip, unlabelled work',
    `${activeBarCount} span${activeBarCount === 1 ? '' : 's'}`,
    data.now !== null ? 'active' : null,
    data.rail.visible ? `${data.rail.marks.length} steering mark${data.rail.marks.length === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ display: 'block', fontFamily: 'inherit' }}
    >
      <defs>
        <pattern id={`fs-hatch-${uid}`} width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill={FLIGHT_STRIP_TRACK_BG} />
          <line x1="0" y1="0" x2="0" y2="4" stroke={FLIGHT_STRIP_HUMAN_COLOR} strokeWidth="2" strokeOpacity="0.5" />
        </pattern>
      </defs>

      {/* Lane track backgrounds + labels — always drawn, even with zero bars, so the strip is never absent. */}
      {rows.map(row => (
        <g key={row.key}>
          <rect x={workX} y={rowY.get(row.key)} width={workW} height={ROW_H} fill={FLIGHT_STRIP_TRACK_BG} />
          {row.label && (
            <text
              x={0}
              y={(rowY.get(row.key) ?? 0) + ROW_H - 1.5}
              fontSize={row.key === 'unclassified' ? 6 : 8.5}
              fill={FLIGHT_STRIP_LABEL_COLOR}
            >
              {row.label}
            </text>
          )}
        </g>
      ))}

      {/* Steering rail — human diamonds and orchestrator hollow squares. Collapses to zero height when empty. */}
      {showRail && (
        <g>
          <text x={0} y={RAIL_H - 3} fontSize={8.5} fill={FLIGHT_STRIP_LABEL_COLOR}>
            STEER
          </text>
          {data.rail.marks.map(mark => {
            const cx = position(mark.position);
            const cy = RAIL_H / 2;
            if (mark.kind === 'human') {
              return <path key={mark.id} d={diamondPath(cx, cy, 4)} fill={FLIGHT_STRIP_HUMAN_COLOR} />;
            }
            return (
              <g key={mark.id}>
                <rect
                  x={cx - 2.5}
                  y={cy - 2.5}
                  width={5}
                  height={5}
                  fill="none"
                  stroke={FLIGHT_STRIP_ORCHESTRATOR_STROKE}
                  strokeWidth={1.2}
                />
                {mark.count > 1 && (
                  <text x={cx + 4} y={cy + 2.5} fontSize={6.5} fill={FLIGHT_STRIP_ORCHESTRATOR_STROKE}>
                    +{mark.count - 1}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      )}

      {/* Bars, laid out per lane; a lane past FLIGHT_STRIP_LANE_FOLD_CAP segments folds its tail into one hatched block. */}
      {rows.map(row => {
        const laneBars = barsByLane.get(row.key) ?? [];
        const y = rowY.get(row.key) ?? 0;
        const { rects, folded } = layoutLaneBars(laneBars, workX, workW);
        return (
          <g key={`bars-${row.key}`}>
            {rects.map((rect, i) => {
              const fill = fillFor(rect.bar);
              if (rect.bar.dashed) {
                return (
                  <rect
                    key={`${row.key}-${i}`}
                    x={rect.x}
                    y={y + 0.5}
                    width={rect.width}
                    height={ROW_H - 1}
                    fill="none"
                    stroke={FLIGHT_STRIP_QUEUED_STROKE}
                    strokeWidth={1}
                    strokeDasharray="3 2"
                  />
                );
              }
              return (
                <rect
                  key={`${row.key}-${i}`}
                  x={rect.x}
                  y={y}
                  width={rect.width}
                  height={ROW_H}
                  fill={fill ?? 'none'}
                />
              );
            })}
            {folded > 0 && (() => {
              const foldStart = rects.filter(r => !r.bar.dashed).slice(-1)[0];
              const tailX = foldStart ? foldStart.x + foldStart.width : workX;
              const laneEndBar = laneBars.filter(b => !b.dashed).slice(-1)[0];
              const tailEndX = laneEndBar ? position(laneEndBar.end) : tailX;
              const foldWidth = Math.max(MIN_BAR_W, tailEndX - tailX);
              return (
                <g>
                  <rect x={tailX} y={y} width={foldWidth} height={ROW_H} fill={`url(#fs-hatch-${uid})`} />
                  <text
                    x={tailX + foldWidth / 2}
                    y={y + ROW_H - 2}
                    fontSize={6.5}
                    fill={FLIGHT_STRIP_HUMAN_COLOR}
                    textAnchor="middle"
                  >
                    +{folded}
                  </text>
                </g>
              );
            })()}
          </g>
        );
      })}

      {/* Now-line for active missions. */}
      {data.now !== null && (
        <line
          x1={position(data.now)}
          y1={0}
          x2={position(data.now)}
          y2={baseline}
          stroke={FLIGHT_STRIP_NOW_COLOR}
          strokeWidth={1.5}
        />
      )}

      {/* Baseline + phase dividers with break glyphs for elided gaps. */}
      <line x1={workX} y1={baseline} x2={workX + workW} y2={baseline} stroke={FLIGHT_STRIP_DIVIDER_STROKE} strokeWidth={1} />
      {data.phases.map((phase, i) => {
        const x = position(phase.position);
        const isFirst = i === 0;
        return (
          <g key={phase.label}>
            {!isFirst && (
              <line
                x1={x}
                y1={tracksTop}
                x2={x}
                y2={baseline}
                stroke={FLIGHT_STRIP_DIVIDER_STROKE}
                strokeWidth={1}
                strokeDasharray="2 2"
              />
            )}
            {phase.idleMs > 0 && (
              // Break glyph: two short diagonal strokes straddling the divider.
              <g stroke={FLIGHT_STRIP_DIVIDER_STROKE} strokeWidth={1}>
                <line x1={x - 3} y1={tracksTop - 2} x2={x - 1} y2={tracksTop + 2} />
                <line x1={x + 1} y1={tracksTop - 2} x2={x + 3} y2={tracksTop + 2} />
              </g>
            )}
            <text x={isFirst ? workX : x} y={baseline + PHASE_LABEL_H - 2} fontSize={8.5} fill={FLIGHT_STRIP_LABEL_COLOR}>
              {phase.idleMs > 0 ? `${formatDuration(phase.idleMs / 60_000)} idle · ${phase.label}` : phase.label}
            </text>
          </g>
        );
      })}
      {data.now !== null && (
        <text x={position(data.now)} y={baseline + PHASE_LABEL_H - 2} fontSize={8.5} fill={FLIGHT_STRIP_NOW_COLOR} textAnchor="middle">
          now
        </text>
      )}
      {data.foldedBars > 0 && (
        <text x={workX + workW} y={baseline + PHASE_LABEL_H - 2} fontSize={8.5} fill={FLIGHT_STRIP_LABEL_COLOR} textAnchor="end">
          +{data.foldedBars} more
        </text>
      )}
    </svg>
  );
}
