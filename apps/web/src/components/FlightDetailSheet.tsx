'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import type { MissionFlightStripData, FlightStripBar, WorkLane } from '@buildd/core/mission-helpers';
import {
  FLIGHT_STRIP_CONCURRENCY_FILL,
  FLIGHT_STRIP_FAILURE_FILL,
  FLIGHT_STRIP_HUMAN_COLOR,
  FLIGHT_STRIP_ORCHESTRATOR_STROKE,
  FLIGHT_STRIP_QUEUED_STROKE,
  FLIGHT_STRIP_DIVIDER_STROKE,
  FLIGHT_STRIP_TRACK_BG,
  FLIGHT_STRIP_LABEL_COLOR,
  FLIGHT_STRIP_NOW_COLOR,
  cullAxisLabels,
} from './FlightStrip';
import { computeFlightDetailStats, describeSteeringPattern, formatFlightDuration } from '@/lib/flight-detail-stats';
import { missionTaskHref, type MissionOrigin } from '@/lib/mission-task-href';
import { findScrollRoot } from '@/lib/scroll-root';

// ─── Expanded-row geometry — normative per the design:flight-strip/flight-detail-sheet
// board (Sheet.dc.html, viewBox 358x170). Distinct from FlightStrip.tsx's compact card
// geometry: full-width tracks (no left label gutter), descriptive labels above each row. ───

const VIEWBOX_W = 358;
const ROW_H = 18;
const RAIL_H = 12;
/** Vertical space reserved above a row for its descriptive label — every row gets this,
 * including the first, so labels never clip past the top of the viewBox. */
const LABEL_H = 12;
/** Gap between the bottom of one row's track and the next row's label. */
const ROW_GAP = 16;
const PHASE_LABEL_H = 14;
const MIN_BAR_W = 2;
/** A bar's hit target: its whole row band plus most of the gap, and never thinner than this. */
const HIT_MIN_W = 12;
const HIT_PAD_Y = 6;
const AXIS_FONT = 9;

/**
 * Indexes of the phase labels that fit on the x-axis without touching each
 * other or the right-aligned duration label — the same collision cull the
 * card strip uses (addendum D4: labels never overlap; an unlabelled gap is
 * fine). A many-phase mission used to print "P8P9P1016m" in a heap. The
 * duration always wins, then the first phase; dividers are unaffected.
 */
export function visiblePhaseLabels(
  phases: ReadonlyArray<{ label: string; position: number }>,
  width: number,
  durationLabel: string,
): number[] {
  const kept = cullAxisLabels(
    [
      ...phases.map((phase, i) => ({
        id: String(i),
        x: i === 0 ? 0 : phase.position * width,
        text: phase.label,
        priority: i === 0 ? 2 : 1,
        anchor: 'start' as const,
      })),
      { id: 'duration', x: width, text: durationLabel, priority: 3, anchor: 'end' as const },
    ],
    { minX: 0, maxX: width, fontSize: AXIS_FONT },
  );
  return kept.filter(l => l.id !== 'duration').map(l => Number(l.id));
}

type LaneKey = WorkLane | 'unclassified' | 'unlabelled';

const LANE_ROW_LABEL: Record<Exclude<LaneKey, 'unlabelled'>, string> = {
  think: 'THINK · research, spec, design',
  build: 'BUILD · engineering',
  check: 'CHECK · review, verify',
  unclassified: 'UNCLASSIFIED · lane unknown',
};

function laneRows(data: MissionFlightStripData): Array<{ key: LaneKey; label: string }> {
  if (!data.hasLaneData) return [{ key: 'unlabelled', label: 'WORK · lane data unavailable' }];
  const rows: Array<{ key: LaneKey; label: string }> = (['think', 'build', 'check'] as const).map(lane => ({
    key: lane,
    label: LANE_ROW_LABEL[lane],
  }));
  if (data.bars.some(b => b.lane === null)) rows.push({ key: 'unclassified', label: LANE_ROW_LABEL.unclassified });
  return rows;
}

function barLaneKey(bar: FlightStripBar, hasLaneData: boolean): LaneKey {
  if (!hasLaneData) return 'unlabelled';
  return bar.lane ?? 'unclassified';
}

function fillFor(bar: FlightStripBar): string | null {
  if (bar.fill === 'failure') return FLIGHT_STRIP_FAILURE_FILL;
  if (bar.fill === 'concurrency') return FLIGHT_STRIP_CONCURRENCY_FILL[Math.max(1, bar.concurrency) as 1 | 2 | 3];
  return null;
}

function diamondPath(cx: number, cy: number, r: number): string {
  return `M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`;
}

/** Pure SVG renderer for the expanded, full-width four-row strip. Shares color tokens and the
 * MissionFlightStripData model with FlightStrip.tsx, but not its compact-card geometry. */
function ExpandedFlightStrip({
  data,
  agentTimeMs,
  selectedTaskId = null,
  onSelect,
  taskTitles,
}: {
  data: MissionFlightStripData;
  agentTimeMs: number;
  selectedTaskId?: string | null;
  onSelect?: (taskId: string) => void;
  taskTitles?: Readonly<Record<string, string>>;
}) {
  const rows = laneRows(data);
  const showRail = data.rail.visible;
  const workW = VIEWBOX_W;
  const position = (p: number) => p * workW;

  // Stack rail (if any) + lane rows top to bottom. Every row, including the first, reserves
  // LABEL_H above its track for its descriptive label, so a label never clips the viewBox top.
  let cursor = LABEL_H;
  const railTop = showRail ? cursor : null;
  if (showRail) cursor += RAIL_H + ROW_GAP;
  const dividerTop = cursor - LABEL_H;
  const rowTop = new Map<LaneKey, number>();
  for (const row of rows) {
    rowTop.set(row.key, cursor);
    cursor += ROW_H + ROW_GAP;
  }
  const baseline = cursor - ROW_GAP;
  const height = baseline + PHASE_LABEL_H + 2;

  const barsByLane = new Map<LaneKey, FlightStripBar[]>();
  for (const bar of data.bars) {
    const key = barLaneKey(bar, data.hasLaneData);
    if (!barsByLane.has(key)) barsByLane.set(key, []);
    barsByLane.get(key)!.push(bar);
  }

  const durationLabel = formatFlightDuration(agentTimeMs);
  const shownPhaseLabels = new Set(visiblePhaseLabels(data.phases, workW, durationLabel));

  const activeBarCount = data.bars.filter(b => !b.dashed).length;
  const ariaLabel = [
    data.hasLaneData ? 'Expanded flight strip' : 'Expanded flight strip, unlabelled work',
    `${activeBarCount} span${activeBarCount === 1 ? '' : 's'} across ${data.phases.length || 1} phase${data.phases.length === 1 ? '' : 's'}`,
  ].join(', ');

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_W} ${height}`}
      width="100%"
      role="img"
      aria-label={ariaLabel}
      style={{ display: 'block', fontFamily: 'inherit' }}
    >
      {showRail && railTop !== null && (
        <g>
          <text x={0} y={railTop - 4} fontSize={9} fill={FLIGHT_STRIP_LABEL_COLOR}>
            STEER · who redirected the mission
          </text>
          <rect x={0} y={railTop} width={workW} height={RAIL_H} fill={FLIGHT_STRIP_TRACK_BG} />
          {data.rail.marks.map(mark => {
            const cx = position(mark.position);
            const cy = railTop + RAIL_H / 2;
            if (mark.kind === 'human') {
              return <path key={mark.id} d={diamondPath(cx, cy, 5)} fill={FLIGHT_STRIP_HUMAN_COLOR} />;
            }
            return (
              <g key={mark.id}>
                <rect x={cx - 3.5} y={cy - 3.5} width={7} height={7} fill="none" stroke={FLIGHT_STRIP_ORCHESTRATOR_STROKE} strokeWidth={1.3} />
                {mark.count > 1 && (
                  <text x={cx + 5} y={cy + 3} fontSize={7} fill={FLIGHT_STRIP_ORCHESTRATOR_STROKE}>
                    +{mark.count - 1}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      )}

      {rows.map(row => {
        const y = rowTop.get(row.key) ?? 0;
        const laneBars = barsByLane.get(row.key) ?? [];
        return (
          <g key={row.key}>
            <text x={0} y={y - 4} fontSize={9} fill={FLIGHT_STRIP_LABEL_COLOR}>
              {row.label}
            </text>
            <rect x={0} y={y} width={workW} height={ROW_H} fill={FLIGHT_STRIP_TRACK_BG} />
            {laneBars.map((bar, i) => {
              const x1 = position(bar.start);
              const x2 = position(bar.end);
              const width = Math.max(MIN_BAR_W, x2 - x1);
              const selected = selectedTaskId !== null && bar.taskId === selectedTaskId;
              // Every drawn bar is a target: selecting it carries the task into
              // "Open mission →" (AC-20). Selection never navigates on its own,
              // so a mis-tap on a thin bar costs nothing. The target is a
              // transparent band (pointer-events all) wider and taller than the
              // drawn bar, so a hollow queued bar or a 2px sliver is still hit.
              const hitW = Math.max(HIT_MIN_W, width);
              const hitX = Math.min(Math.max(0, x1 - (hitW - width) / 2), workW - hitW);
              const title = taskTitles?.[bar.taskId];
              const lane = row.label.split(' · ')[0];
              const tap = {
                'data-testid': 'flight-detail-bar',
                'data-task-id': bar.taskId,
                role: 'button' as const,
                tabIndex: 0,
                'aria-pressed': selected,
                'aria-label': title ? `Select ${title} (${lane})` : `Select task ${i + 1} in ${lane}`,
                style: { cursor: 'pointer' },
                onClick: () => onSelect?.(bar.taskId),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(bar.taskId);
                  }
                },
              };
              const ring = selected ? (
                <rect x={x1 - 1.5} y={y - 1.5} width={width + 3} height={ROW_H + 3} fill="none" stroke={FLIGHT_STRIP_NOW_COLOR} strokeWidth={2} pointerEvents="none" />
              ) : null;
              const hit = (
                <rect
                  x={hitX}
                  y={y - HIT_PAD_Y}
                  width={hitW}
                  height={ROW_H + HIT_PAD_Y * 2}
                  fill="transparent"
                  pointerEvents="all"
                  {...tap}
                />
              );
              if (bar.dashed) {
                return (
                  <g key={`${row.key}-${i}`}>
                    <rect
                      x={x1}
                      y={y + 0.5}
                      width={Math.max(MIN_BAR_W, width)}
                      height={ROW_H - 1}
                      fill="none"
                      stroke={FLIGHT_STRIP_QUEUED_STROKE}
                      strokeWidth={1}
                      strokeDasharray="3 2"
                      pointerEvents="none"
                    />
                    {ring}
                    {hit}
                  </g>
                );
              }
              return (
                <g key={`${row.key}-${i}`}>
                  <rect x={x1} y={y} width={width} height={ROW_H} fill={fillFor(bar) ?? 'none'} pointerEvents="none" />
                  {ring}
                  {hit}
                </g>
              );
            })}
          </g>
        );
      })}

      {/* Phase-boundary dividers on the x-axis — independent of the lane rows on the y-axis. */}
      {data.phases.slice(1).map(phase => (
        <line
          key={`div-${phase.label}`}
          x1={position(phase.position)}
          y1={dividerTop}
          x2={position(phase.position)}
          y2={baseline}
          stroke={FLIGHT_STRIP_DIVIDER_STROKE}
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      ))}

      <line x1={0} y1={baseline} x2={workW} y2={baseline} stroke={FLIGHT_STRIP_DIVIDER_STROKE} strokeWidth={1} />
      {data.phases.map((phase, i) => shownPhaseLabels.has(i) && (
        <text
          key={phase.label}
          x={i === 0 ? 0 : position(phase.position)}
          y={baseline + PHASE_LABEL_H - 2}
          fontSize={AXIS_FONT}
          fill={FLIGHT_STRIP_LABEL_COLOR}
        >
          {phase.label}
        </text>
      ))}
      <text x={workW} y={baseline + PHASE_LABEL_H - 2} fontSize={AXIS_FONT} fill={FLIGHT_STRIP_LABEL_COLOR} textAnchor="end">
        {durationLabel}
      </text>
    </svg>
  );
}

interface StatTileProps {
  value: string;
  label: string;
  accent?: boolean;
}

function StatTile({ value, label, accent }: StatTileProps) {
  return (
    <div className="border border-border-default px-2.5 py-2 flex flex-col gap-1">
      <span className={`text-base ${accent ? 'text-accent-text' : 'text-text-primary'}`}>{value}</span>
      <span className="text-[10px] text-text-muted">{label}</span>
    </div>
  );
}

function LegendSwatch({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-text-muted">
      <span className="flex items-center shrink-0" aria-hidden="true">{children}</span>
      <span>{label}</span>
    </div>
  );
}

/** Dispatched on the sheet's dialog element to ask it to close. */
const FLIGHT_DETAIL_CLOSE_EVENT = 'flightdetail:close';

/**
 * Close the flight detail sheet `target` sits in, if any. The mission page's
 * task-sheet owner calls this when a bar tap opens a task, so the flight sheet
 * can never stay stacked over (or under) the task sheet. Returns whether a
 * sheet was asked to close.
 */
export function closeEnclosingFlightDetailSheet(target: EventTarget | null): boolean {
  const el = target as { closest?: (sel: string) => Element | null } | null;
  const dialog = el?.closest?.('[data-flight-detail-sheet]');
  if (!dialog) return false;
  dialog.dispatchEvent(new CustomEvent(FLIGHT_DETAIL_CLOSE_EVENT));
  return true;
}

export interface FlightDetailSheetProps {
  open: boolean;
  onClose: () => void;
  data: MissionFlightStripData;
  missionId: string;
  missionTitle: string;
  /** Breadcrumb origin carried into the mission (`?from=`). */
  from?: MissionOrigin | null;
  /** A bar already selected when the sheet opens. */
  initialTaskId?: string | null;
  /** Task titles by id, for the bars' accessible names. */
  taskTitles?: Readonly<Record<string, string>>;
}

/** Bottom sheet reached from a mission card's ⤢ control (Home and the missions
 * list). Renders the expanded four-row strip, derived stats, legend, a
 * plain-language steering summary, and "Open mission →". Selecting a bar
 * carries that task into the mission as its sheet
 * (docs/design/mission-feed-mobile-continuity.md, W1, AC-20). */
export function FlightDetailSheet({ open, onClose, data, missionId, missionTitle, from = null, initialTaskId = null, taskTitles }: FlightDetailSheetProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialTaskId);
  // The sheet stays mounted while closed; each opening starts from
  // `initialTaskId`, not from the last opening's selection.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSelectedTaskId(initialTaskId);
  }
  const headingId = useId();
  const closeRef = useRef<HTMLAnchorElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement;
    closeRef.current?.focus();
    // Lock the shell's scroller (<main data-scroll-root>), not body: the app
    // shell never scrolls the document, so a body lock left the page moving.
    const scrollRoot = findScrollRoot(document);
    const previousOverflow = scrollRoot.style.overflow;
    scrollRoot.style.overflow = 'hidden';

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    const dialog = dialogRef.current;
    const handleCloseRequest = () => onClose();
    dialog?.addEventListener(FLIGHT_DETAIL_CLOSE_EVENT, handleCloseRequest);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      dialog?.removeEventListener(FLIGHT_DETAIL_CLOSE_EVENT, handleCloseRequest);
      scrollRoot.style.overflow = previousOverflow;
      if (restoreFocusRef.current instanceof HTMLElement) restoreFocusRef.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const stats = computeFlightDetailStats(data);
  const openHref = selectedTaskId
    ? missionTaskHref({ missionId, taskId: selectedTaskId, from, mode: 'sheet' })
    : `/app/missions/${encodeURIComponent(missionId)}${from ? `?from=${encodeURIComponent(from)}` : ''}`;
  const summary = describeSteeringPattern(data);

  const sheet = (
    <div ref={dialogRef} data-flight-detail-sheet="" className="fixed inset-0 z-50" aria-modal="true" role="dialog" aria-labelledby={headingId} onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      {/* Block layout, not a flex column: with max-h + overflow a flex column
          shrinks its children to fit (the chart squashed, the title clipped)
          instead of scrolling. */}
      <div
        data-testid="flight-detail-panel"
        className="absolute bottom-0 left-0 right-0 bg-surface-2 border-t-2 border-border-strong px-4 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] space-y-4 max-h-[90dvh] overflow-y-auto overscroll-contain"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span id={headingId} className="text-[11px] tracking-[0.12em] text-text-muted">FLIGHT DETAIL</span>
          <a
            ref={closeRef}
            href="#"
            onClick={e => { e.preventDefault(); onClose(); }}
            aria-label="Close"
            className="flex items-center justify-center w-11 h-11 text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </a>
        </div>

        <h2 className="text-[17px] font-medium leading-6 text-text-primary line-clamp-2">{missionTitle}</h2>

        <ExpandedFlightStrip
          data={data}
          agentTimeMs={stats.agentTimeMs}
          selectedTaskId={selectedTaskId}
          taskTitles={taskTitles}
          onSelect={id => setSelectedTaskId(prev => (prev === id ? null : id))}
        />

        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <LegendSwatch label="You stepped in">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1l5 5-5 5-5-5z" fill={FLIGHT_STRIP_HUMAN_COLOR} /></svg>
          </LegendSwatch>
          <LegendSwatch label="Orchestrator ran a model">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke={FLIGHT_STRIP_ORCHESTRATOR_STROKE} strokeWidth={1.3} /></svg>
          </LegendSwatch>
          <LegendSwatch label="1, 2, 3+ in parallel">
            <span className="flex">
              <span className="w-2.5 h-2.5" style={{ background: FLIGHT_STRIP_CONCURRENCY_FILL[1] }} />
              <span className="w-2.5 h-2.5" style={{ background: FLIGHT_STRIP_CONCURRENCY_FILL[2] }} />
              <span className="w-2.5 h-2.5" style={{ background: FLIGHT_STRIP_CONCURRENCY_FILL[3] }} />
            </span>
          </LegendSwatch>
          <LegendSwatch label="Failed, retried">
            <span className="w-2.5 h-2.5" style={{ background: FLIGHT_STRIP_FAILURE_FILL }} />
          </LegendSwatch>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <StatTile value={formatFlightDuration(stats.agentTimeMs)} label="agent time" />
          <StatTile value={formatFlightDuration(stats.idleElidedMs)} label="idle, not drawn" />
          <StatTile
            value={stats.buildCheckLoops === null ? '—' : `${stats.buildCheckLoops} loop${stats.buildCheckLoops === 1 ? '' : 's'}`}
            label="build ↔ check"
            accent
          />
          <StatTile
            value={stats.humanPct === null ? '—' : `${Math.round(stats.humanPct)}%`}
            label="human-steered"
          />
        </div>

        <p className="text-[12px] leading-[19px] text-text-secondary">{summary}</p>

        <Link
          data-testid="flight-detail-open-mission"
          href={openHref}
          className="flex items-center justify-center min-h-[48px] border-2 border-border-strong text-[13px] text-text-primary hover:bg-surface-3"
        >
          {selectedTaskId ? 'Open task in mission →' : 'Open mission →'}
        </Link>
      </div>
    </div>
  );

  // Portal to <body>: the ⤢ trigger lives inside the sticky mission masthead,
  // whose z-20 stacking context would otherwise trap this z-50 sheet under the
  // fixed bottom nav. Server render (never open there in practice) stays inline.
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
}
