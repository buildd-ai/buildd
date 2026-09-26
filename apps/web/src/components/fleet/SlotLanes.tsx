'use client';

/**
 * SlotLanes: machines as rows, their concurrent agent slots as sub-rows, work
 * as bars on a shared time axis.
 *
 * ```
 *          0m     5m     10m    NOW
 * PHASE    |1 FOUNDATIONS  |2 THROUGH
 * A atlas·1 [db columns ✓] [export CSV     ▌░░░░
 *        ·2  [money ✓]                     ░░░░░
 * MERGED 2        ■411 ■412
 * ```
 *
 * Generic on purpose — the mission page's Lanes tab and the home fleet panel
 * both draw it — so it knows lanes, bars and marks, never tasks or missions.
 * Slots come from overlap (`assignSlots`): nothing stores which slot an agent
 * held. Hovering a bar draws edges from the bars it depends on (`deps`, by
 * `group`) and reports it through `onHover`; a bar with `href` is a real link.
 */
import Link from 'next/link';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { assignSlots, axisFraction, axisTicks, formatAxisMinutes, SLOT_LANE_AXIS_PX, SLOT_LANE_ROW_PX } from './slot-lanes-layout';

export type SlotLaneTone = 'live' | 'done' | 'waiting' | 'plan' | 'foreign';

export interface SlotLaneBar {
  id: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms; null while live (drawn to `now`). */
  end: number | null;
  tone: SlotLaneTone;
  /** Small leading tag, e.g. a scope chip. */
  scope?: string | null;
  label: string;
  /** Prefix glyph before the scope, e.g. `↻` for a retry. */
  prefix?: string | null;
  endMark?: 'ok' | 'fail' | 'ci' | null;
  /** Spans the bar was waiting on a human, drawn as a hatched underline. */
  waits?: ReadonlyArray<{ start: number; end: number | null }>;
  /** Bars sharing a group are one unit of work (edges connect groups). */
  group?: string;
  /** Groups this bar waited on. */
  deps?: readonly string[];
  href?: string;
  /** Extra attributes for the link, e.g. `data-task-id` for a sheet handler. */
  linkData?: Readonly<Record<`data-${string}`, string>>;
  title?: string;
}

export interface SlotLane {
  id: string;
  label: string;
  /** One-letter avatar. Defaults to the label's first letter. */
  badge?: string;
  bars: readonly SlotLaneBar[];
  /** Draw at least this many slot rows. */
  minSlots?: number;
}

export interface SlotLanesProps {
  lanes: readonly SlotLane[];
  /** Axis window, epoch ms. */
  from: number;
  to: number;
  /** Draws the NOW line and hatches the future. Null for a finished run. */
  now?: number | null;
  nowLabel?: string;
  phases?: ReadonlyArray<{ id: string; label: string; start: number; end: number }>;
  phasesLabel?: string;
  marks?: ReadonlyArray<{ id: string; at: number; label: string; tone: 'ok' | 'fail' }>;
  marksLabel?: string;
  onHover?: (bar: SlotLaneBar | null) => void;
  /** Bar held highlighted when nothing is hovered. */
  pinnedId?: string | null;
  testId?: string;
  className?: string;
  /**
   * Draw the lane-label column. Off when a caller renders its own row labels
   * beside the chart (Home's fleet table) — rows stay `ROW_PX` tall so the two
   * line up.
   */
  labels?: boolean;
  /** No border or shadow: the caller's card frames the chart. */
  bare?: boolean;
  /** Axis tick text for a tick at epoch `at`. Default: minutes from `from` ("5m"). */
  tickLabel?: (at: number) => string;
}

const LABEL_COL_PX = 104;
const ROW_PX = SLOT_LANE_ROW_PX;
/** Below this share of the axis a live bar's label goes beside it. */
const OUTSIDE_LABEL_FRACTION = 0.06;

const TONE_CLASS: Record<SlotLaneTone, string> = {
  live: 'border-accent bg-accent-soft',
  done: 'border-border-strong bg-surface-3',
  waiting: 'border-2 border-accent bg-card',
  plan: 'border-dashed border-border-strong bg-transparent',
  foreign: 'border-dashed border-[var(--fleet-border-mid)] bg-transparent',
};

const END_MARK: Record<'ok' | 'fail' | 'ci', { glyph: string; cls: string }> = {
  ok: { glyph: '✓', cls: 'text-status-success' },
  fail: { glyph: '✕', cls: 'text-status-error' },
  ci: { glyph: '◌', cls: 'text-accent-text' },
};

export default function SlotLanes({
  lanes, from, to, now = null, nowLabel, phases, phasesLabel = 'Phase', marks, marksLabel,
  onHover, pinnedId = null, testId = 'slot-lanes', className = '',
  labels = true, bare = false, tickLabel,
}: SlotLanesProps) {
  const labelPx = labels ? LABEL_COL_PX : 0;
  const pct = (t: number) => `${axisFraction(t, from, to) * 100}%`;
  const width = (a: number, b: number) => `${Math.max(0, axisFraction(b, from, to) - axisFraction(a, from, to)) * 100}%`;
  const drawEnd = (b: { end: number | null }) => b.end ?? now ?? to;

  const rows = useMemo(() => lanes.flatMap(lane => {
    const a = assignSlots(lane.bars);
    const n = Math.max(a.slots, lane.minSlots ?? 1);
    return Array.from({ length: n }, (_, slot) => ({ lane, slot, bars: a.bySlot[slot] ?? [] }));
  }), [lanes]);

  const { stepMin, ticks } = axisTicks(to - from, 10);
  const [hovered, setHovered] = useState<SlotLaneBar | null>(null);
  const active = hovered ?? (pinnedId ? lanes.flatMap(l => l.bars).find(b => b.id === pinnedId) ?? null : null);
  const hover = (b: SlotLaneBar | null) => {
    setHovered(b);
    onHover?.(b);
  };

  // Dependency edges for the active bar, measured from the DOM so they follow
  // whatever the layout did with the bars.
  const chartRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Array<{ d: string; x: number; y: number }>>([]);
  useLayoutEffect(() => {
    const root = chartRef.current;
    if (!root || !active?.deps?.length) {
      setEdges(e => (e.length ? [] : e));
      return;
    }
    const cr = root.getBoundingClientRect();
    const target = root.querySelector<HTMLElement>(`[data-bar-id="${CSS.escape(active.id)}"]`);
    if (!target) return;
    const t = target.getBoundingClientRect();
    const out: Array<{ d: string; x: number; y: number }> = [];
    for (const dep of active.deps) {
      const els = Array.from(root.querySelectorAll<HTMLElement>(`[data-bar-group="${CSS.escape(dep)}"]`));
      const src = els.sort((x, y) => y.getBoundingClientRect().right - x.getBoundingClientRect().right)[0];
      if (!src) continue;
      const r = src.getBoundingClientRect();
      const x1 = r.right - cr.left, y1 = r.top + r.height / 2 - cr.top;
      const x2 = t.left - cr.left, y2 = t.top + t.height / 2 - cr.top;
      const xm = Math.min(x1 + 10, x2 - 6);
      out.push({ d: `M${x1} ${y1} H${xm} V${y2} H${x2 - 1}`, x: x2, y: y2 });
    }
    setEdges(out);
  }, [active]);
  const activeGroups = new Set([...(active?.deps ?? []), ...(active?.group ? [active.group] : [])]);

  const grid = (
    <>
      {ticks.slice(1).map(m => (
        <i key={m} aria-hidden="true" className="absolute inset-y-0 w-px bg-border-default opacity-60" style={{ left: pct(from + m * 60_000) }} />
      ))}
    </>
  );

  return (
    <div
      ref={chartRef}
      data-testid={testId}
      className={`relative ${bare ? '' : 'border-2 border-border-strong bg-card shadow-[var(--card-shadow)]'} ${className}`}
      onMouseLeave={() => hover(null)}
    >
      {/* Axis */}
      <div className="grid border-b border-border-default" style={{ gridTemplateColumns: `${labelPx}px 1fr`, height: SLOT_LANE_AXIS_PX }}>
        <div />
        <div className="relative">
          {ticks.filter(m => axisFraction(from + m * 60_000, from, to) < 0.97).map(m => (
            <span key={m} className="absolute top-[9px] -translate-x-1/2 font-mono text-[11px] md:text-[10.5px] text-[var(--fleet-faint)] tabular-nums" style={{ left: pct(from + m * 60_000) }}>
              {tickLabel ? tickLabel(from + m * 60_000) : formatAxisMinutes(m)}
            </span>
          ))}
        </div>
      </div>
      <span className="sr-only">{`Axis step ${stepMin} minutes`}</span>

      {phases && phases.length > 0 && (
        <div className="grid h-[26px] border-b border-border-default" style={{ gridTemplateColumns: `${labelPx}px 1fr` }}>
          <div className="flex items-center border-r border-border-default pl-3 font-mono text-[11px] md:text-[9.5px] font-semibold uppercase tracking-[1.6px] text-text-muted">{phasesLabel}</div>
          <div className="relative overflow-hidden">
            {phases.map(p => (
              <span
                key={p.id}
                className="absolute top-[7px] h-3 truncate border-b-[1.5px] border-l-2 border-b-[var(--fleet-faint)] border-l-text-secondary pl-1 font-mono text-[11px] md:text-[9.5px] font-semibold uppercase leading-[9px] tracking-[0.8px] text-text-muted"
                style={{ left: pct(p.start), width: width(p.start, p.end) }}
              >
                {p.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {rows.map(({ lane, slot, bars }, i) => (
        <div
          key={`${lane.id}:${slot}`}
          data-testid="slot-lane-row"
          className={`grid border-b border-border-default ${slot === 0 && i > 0 ? 'border-t-[1.5px] border-t-[var(--fleet-border-mid)]' : ''}`}
          style={{ gridTemplateColumns: `${labelPx}px 1fr`, height: ROW_PX }}
        >
          {labels ? (
          <div className="flex items-center gap-[7px] border-r border-border-default pl-3 font-mono text-[11.5px] text-text-secondary">
            <span className={`grid h-5 w-5 shrink-0 place-items-center border-[1.5px] border-border-strong bg-surface-1 text-[11px] md:text-[10.5px] font-bold uppercase text-text-primary ${slot ? 'invisible' : ''}`}>
              {lane.badge ?? lane.label.slice(0, 1)}
            </span>
            {slot === 0 && <span className="min-w-0 truncate">{lane.label}</span>}
            <span className="text-[var(--fleet-faint)]">{`·${slot + 1}`}</span>
          </div>
          ) : <div />}
          <div className="relative overflow-hidden">
            {grid}
            {bars.map(b => {
              const end = drawEnd(b);
              const frac = axisFraction(end, from, to) - axisFraction(b.start, from, to);
              const outside = b.end == null && frac < OUTSIDE_LABEL_FRACTION;
              const isActive = active?.id === b.id || (!!b.group && activeGroups.has(b.group));
              const content = (
                <>
                  {!outside && <BarLabel bar={b} />}
                  {b.endMark && <span className={`ml-auto shrink-0 text-[11px] font-bold ${END_MARK[b.endMark].cls}`}>{END_MARK[b.endMark].glyph}</span>}
                </>
              );
              const cls = `absolute top-[9px] flex h-8 items-center gap-1.5 overflow-hidden whitespace-nowrap border-[1.5px] px-[7px] font-mono text-[11.5px] text-text-secondary ${TONE_CLASS[b.tone]} ${isActive ? 'z-[3] shadow-[3px_3px_0_0_var(--border-strong)]' : ''}`;
              const style = { left: pct(b.start), width: `calc(${width(b.start, end)} - 2px)` };
              const common = {
                'data-testid': 'lane-bar',
                'data-bar-id': b.id,
                'data-bar-group': b.group ?? b.id,
                'data-tone': b.tone,
                title: b.title,
                className: cls,
                style,
                onMouseEnter: () => hover(b),
                onFocus: () => hover(b),
              } as const;
              return (
                <span key={b.id}>
                  {b.href ? (
                    <Link href={b.href} {...(b.linkData ?? {})} {...common}>{content}</Link>
                  ) : (
                    <span {...common}>{content}</span>
                  )}
                  {b.end == null && b.tone === 'live' && (
                    <span aria-hidden="true" className="absolute top-[7px] z-[2] h-9 w-1 animate-status-pulse bg-accent" style={{ left: `calc(${pct(end)} - 4px)` }} />
                  )}
                  {b.tone === 'waiting' && (
                    <span aria-hidden="true" className="absolute top-[9px] z-[5] grid h-8 w-[22px] place-items-center bg-accent text-[13px] font-bold text-white" style={{ left: `calc(${pct(end)} - 22px)` }}>?</span>
                  )}
                  {outside && (
                    <span className="pointer-events-none absolute top-[9px] flex h-8 items-center gap-1.5 whitespace-nowrap font-mono text-[11.5px]" style={{ left: `calc(${pct(end)} + 8px)` }}>
                      <BarLabel bar={b} />
                    </span>
                  )}
                  {(b.waits ?? []).map((w, wi) => (
                    <span
                      key={wi}
                      aria-hidden="true"
                      className="fleet-hatch-accent absolute top-[43px] z-[5] h-1.5 border border-accent"
                      style={{ left: pct(w.start), width: width(w.start, w.end ?? now ?? to) }}
                    />
                  ))}
                </span>
              );
            })}
          </div>
        </div>
      ))}

      {marks && (
        <div className="grid h-10 border-t-2 border-border-strong" style={{ gridTemplateColumns: `${labelPx}px 1fr` }}>
          <div className="flex items-center border-r border-border-default pl-3 font-mono text-[11px] md:text-[9.5px] font-semibold uppercase tracking-[1.6px] text-status-success">
            {marksLabel ?? ''}
          </div>
          <div className="relative overflow-hidden">
            {grid}
            {marks.map(m => (
              <span
                key={m.id}
                data-testid="slot-lanes-mark"
                className={`absolute top-2.5 flex -translate-x-1/2 flex-col items-center gap-[3px] font-mono text-[11px] md:text-[9.5px] font-semibold ${m.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}
                style={{ left: pct(m.at) }}
              >
                <i className={`block h-2.5 w-2.5 ${m.tone === 'ok' ? 'bg-status-success' : 'border-2 border-status-error'}`} />
                {m.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {now != null && now < to && (
        <>
          <div
            aria-hidden="true"
            className="fleet-hatch-future pointer-events-none absolute inset-y-0 right-0"
            style={{ left: `calc(${labelPx}px + (100% - ${labelPx}px) * ${axisFraction(now, from, to)})` }}
          />
          <div
            data-testid="slot-lanes-now"
            className="pointer-events-none absolute inset-y-0 z-[6] w-0.5 bg-accent"
            style={{ left: `calc(${labelPx}px + (100% - ${labelPx}px) * ${axisFraction(now, from, to)})` }}
          >
            <span className="absolute -left-px -top-[22px] whitespace-nowrap bg-accent px-[5px] py-0.5 font-mono text-[11px] md:text-[10px] font-bold tracking-[0.5px] text-white">
              {nowLabel ?? 'NOW'}
            </span>
          </div>
        </>
      )}

      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-[4] h-full w-full overflow-visible">
        {edges.map((e, i) => (
          <g key={i} data-testid="slot-lanes-edge">
            <path d={e.d} fill="none" stroke="var(--text-primary)" strokeWidth={1.5} />
            <rect x={e.x - 5} y={e.y - 3} width={6} height={6} fill="var(--text-primary)" />
          </g>
        ))}
      </svg>
    </div>
  );
}

function BarLabel({ bar }: { bar: SlotLaneBar }): ReactNode {
  const tone = bar.tone === 'live' || bar.tone === 'waiting' ? 'text-accent-text' : 'text-text-muted';
  return (
    <>
      {(bar.prefix || bar.scope) && (
        <span className={`shrink-0 text-[11px] md:text-[10.5px] font-semibold ${tone}`}>
          {bar.prefix ? `${bar.prefix} ` : ''}{bar.scope ?? ''}
        </span>
      )}
      <span className={`min-w-0 truncate font-semibold ${bar.tone === 'foreign' ? 'font-medium text-[var(--fleet-faint)]' : 'text-text-primary'}`}>{bar.label}</span>
    </>
  );
}
