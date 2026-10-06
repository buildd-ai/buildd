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
import { assignSlots, axisFraction, axisTicks, dependencyEdge, formatAxisMinutes, SLOT_LANE_AXIS_PX, SLOT_LANE_ROW_PX } from './slot-lanes-layout';

export type SlotLaneTone = 'live' | 'done' | 'waiting' | 'plan' | 'foreign' | 'side' | 'stopped';

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
  /** Extra facts for the hover card ("done · Builder · PR #12"), one per line. */
  details?: readonly string[];
}

export interface SlotLane {
  id: string;
  label: string;
  /** One-letter avatar. Defaults to the label's first letter. */
  badge?: string;
  bars: readonly SlotLaneBar[];
  /** Draw at least this many slot rows. */
  minSlots?: number;
  /**
   * Pre-assigned slot rows, drawn as given instead of derived from `bars` —
   * for a caller that folds some slots away and draws its own labels beside
   * the rows it kept (Home's fleet table).
   */
  rows?: ReadonlyArray<readonly SlotLaneBar[]>;
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
  /**
   * Hovering a bar opens a card (full title, when, how long, `details`) in
   * place of the native tooltip, which a row of thin ticks made useless.
   */
  hoverCard?: boolean;
}

function formatSpan(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1m';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/** What a bar's hover card says, as text: pure, so it is testable without a DOM. */
export function barCard(
  bar: Pick<SlotLaneBar, 'label' | 'title' | 'start' | 'end' | 'details'>,
  opts: { now: number | null; clock?: (at: number) => string },
): { title: string | null; when: string; details: readonly string[] } {
  const clock = opts.clock ?? ((at: number) => new Date(at).toISOString().slice(11, 16));
  const end = bar.end ?? opts.now ?? bar.start;
  const span = formatSpan(end - bar.start);
  return {
    title: bar.title && bar.title !== bar.label ? bar.title : null,
    when: bar.end == null ? `${clock(bar.start)} → now · ${span} so far` : `${clock(bar.start)} → ${clock(bar.end)} · ${span}`,
    details: bar.details ?? [],
  };
}

const LABEL_COL_PX = 104;
const CARD_PX = 288;
const ROW_PX = SLOT_LANE_ROW_PX;
/** Below this share of the axis a live bar's label goes beside it. */
const OUTSIDE_LABEL_FRACTION = 0.06;
/**
 * Below this share of the axis a bar cannot hold its label box (chip + a word
 * + padding) without clipping it to "mon" / "rese", or — finished — to an
 * empty box with half a tick in it. It draws as the short-run marker: a thin
 * bar with no content (an open one ends at NOW, a finished one sits at its own
 * start). The label goes beside it, left, when there is room, else into its
 * tooltip.
 */
export const SHORT_FRACTION = 0.1;
/**
 * An open bar younger than this is a claim the runner has not really started:
 * as a bar it would be a sliver under the NOW line with its label floating
 * beside nothing. It draws as a marker just left of NOW, labelled "claimed".
 */
const CLAIMED_MS = 60_000;

const TONE_CLASS: Record<SlotLaneTone, string> = {
  live: 'border-accent bg-accent-soft',
  done: 'border-border-strong bg-surface-3',
  waiting: 'border-2 border-accent bg-card',
  plan: 'border-dashed border-border-strong bg-transparent',
  foreign: 'border-dashed border-[var(--fleet-border-mid)] bg-transparent',
  // Filed beside the work (a friction report): dotted, faint, never solid.
  side: 'border-dotted border-[var(--fleet-border-mid)] bg-transparent',
  // Failed or cancelled without a PR, or orphaned: an error-toned outline.
  stopped: 'border-status-error bg-transparent',
};

/** The short-run tick for a tone that is not "done" work. */
const TICK_TONE: Partial<Record<SlotLaneTone, string>> = {
  side: 'border-dotted border-text-muted bg-transparent',
  stopped: 'border-status-error bg-transparent',
};

const END_MARK: Record<'ok' | 'fail' | 'ci', { glyph: string; cls: string }> = {
  ok: { glyph: '✓', cls: 'text-status-success' },
  fail: { glyph: '✕', cls: 'text-status-error' },
  ci: { glyph: '◌', cls: 'text-accent-text' },
};

export default function SlotLanes({
  lanes, from, to, now = null, nowLabel, phases, phasesLabel = 'Phase', marks, marksLabel,
  onHover, pinnedId = null, testId = 'slot-lanes', className = '',
  labels = true, bare = false, tickLabel, hoverCard = false,
}: SlotLanesProps) {
  const labelPx = labels ? LABEL_COL_PX : 0;
  const pct = (t: number) => `${axisFraction(t, from, to) * 100}%`;
  const width = (a: number, b: number) => `${Math.max(0, axisFraction(b, from, to) - axisFraction(a, from, to)) * 100}%`;
  const drawEnd = (b: { end: number | null }) => b.end ?? now ?? to;

  const rows = useMemo(() => lanes.flatMap(lane => {
    if (lane.rows) return lane.rows.map((bars, slot) => ({ lane, slot, bars: [...bars] }));
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
      const rel = (b: DOMRect) => ({ left: b.left - cr.left, right: b.right - cr.left, top: b.top - cr.top, bottom: b.bottom - cr.top });
      out.push(dependencyEdge(rel(r), rel(t)));
    }
    setEdges(out);
  }, [active]);
  // The hover card is viewport-fixed, so the overflow-clipped table it sits
  // in cannot cut it: under the bar, or above it when the viewport has no
  // room below. Measured after it renders, so its real height decides.
  const cardRef = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const root = chartRef.current;
    if (!hoverCard || !root || !hovered) {
      setCard(c => (c ? null : c));
      return;
    }
    const target = root.querySelector<HTMLElement>(`[data-bar-id="${CSS.escape(hovered.id)}"]`);
    if (!target) return;
    const t = target.getBoundingClientRect();
    const h = cardRef.current?.offsetHeight ?? 140;
    const left = Math.max(8, Math.min(t.left, window.innerWidth - CARD_PX - 8));
    const below = t.bottom + 6;
    setCard({ left, top: below + h > window.innerHeight - 8 && t.top - h - 6 > 8 ? t.top - h - 6 : below });
  }, [hovered, hoverCard]);
  // A scroll moves the bar out from under a fixed card; drop it.
  useLayoutEffect(() => {
    if (!hoverCard || !hovered) return;
    const drop = () => setHovered(null);
    window.addEventListener('scroll', drop, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', drop, { capture: true });
  }, [hovered, hoverCard]);
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
            {bars.map((b, bi) => {
              const end = drawEnd(b);
              // Wholly outside the axis: clamped, it would draw as an empty
              // box at the edge. Its slot still counts (rows line up).
              if (end <= from || b.start >= to) return null;
              const startFrac = axisFraction(b.start, from, to);
              const frac = axisFraction(end, from, to) - startFrac;
              // An open bar too short for its label ends at NOW, so the space to
              // its right is the future hatch. Its label goes to its left, into
              // the gap since the slot's previous bar; with no gap it stays
              // inside the bar and truncates.
              const prevEnd = bars.slice(0, bi).reduce((mx, p) => Math.max(mx, drawEnd(p)), from);
              const gap = startFrac - axisFraction(prevEnd, from, to);
              const claimed = b.end == null && b.tone === 'live' && end - b.start < CLAIMED_MS;
              const short = !claimed && frac < SHORT_FRACTION;
              // A finished marker's label stays in its tooltip: squeezed into the
              // gap before it, it read as a clipped "pla…" beside an empty box.
              const outside = short && b.end == null && gap >= OUTSIDE_LABEL_FRACTION;
              const tick = short && b.end != null;
              const tooltip = [b.label, b.title && b.title !== b.label ? b.title : null].filter(Boolean).join(' · ');
              const shortTitle = b.end == null
                ? [b.prefix, b.scope, b.label].filter(Boolean).join(' ')
                : tooltip;
              const isActive = active?.id === b.id || (!!b.group && activeGroups.has(b.group));
              const content = short || claimed ? null : (
                <>
                  <BarLabel bar={b} />
                  {b.endMark && <span className={`ml-auto shrink-0 text-[11px] font-bold ${END_MARK[b.endMark].cls}`}>{END_MARK[b.endMark].glyph}</span>}
                </>
              );
              const tickTone = TICK_TONE[b.tone] ?? (b.endMark === 'fail' ? 'border-status-error bg-status-error' : b.endMark === 'ok' ? 'border-status-success bg-status-success' : 'border-text-muted bg-text-muted');
              const cls = claimed
                ? `absolute top-[9px] z-[7] block h-8 w-2 animate-status-pulse border-[1.5px] border-accent bg-accent ${isActive ? 'shadow-[3px_3px_0_0_var(--border-strong)]' : ''}`
                : tick
                  // The short-run marker: a solid tick at the run's start, never an empty box.
                  ? `absolute top-[9px] z-[1] block h-8 w-1.5 border-[1.5px] ${tickTone} ${isActive ? 'z-[3] shadow-[2px_2px_0_0_var(--border-strong)]' : ''}`
                  : `absolute top-[9px] flex h-8 items-center gap-1.5 overflow-hidden whitespace-nowrap border-[1.5px] ${short ? 'px-0' : 'px-[7px]'} font-mono text-[11.5px] text-text-secondary ${TONE_CLASS[b.tone]} ${isActive ? 'z-[3] shadow-[3px_3px_0_0_var(--border-strong)]' : ''}`;
              const nowRight = (1 - axisFraction(end, from, to)) * 100;
              // An open bar is anchored by its right edge at NOW: a box has a
              // minimum drawn width, and anchored at its start a fresh bar
              // poked past the NOW line into the future. A claim sits just left
              // of the line, which would otherwise cover it.
              const style = claimed
                ? { right: `calc(${nowRight}% + 4px)` }
                : short && b.end == null
                  ? { right: `${nowRight}%`, width: `max(calc(${width(b.start, end)} - 2px), 6px)` }
                  : tick
                    ? { left: pct(b.start) }
                    : { left: pct(b.start), width: `calc(${width(b.start, end)} - 2px)` };
              const claimedTitle = `${[b.prefix, b.scope, b.label].filter(Boolean).join(' ')} · claimed`;
              const common = {
                'data-testid': 'lane-bar',
                'data-bar-id': b.id,
                'data-bar-group': b.group ?? b.id,
                'data-tone': b.tone,
                ...(short ? { 'data-shape': 'short', 'aria-label': shortTitle } : {}),
                ...(claimed ? { 'data-shape': 'claimed', 'aria-label': claimedTitle } : {}),
                // The card replaces the native tooltip; two at once is noise.
                title: hoverCard ? undefined : claimed ? claimedTitle : short ? shortTitle : b.title,
                className: cls,
                style,
                onMouseEnter: () => hover(b),
                onFocus: () => hover(b),
                ...(hoverCard ? { onMouseLeave: () => hover(null), onBlur: () => hover(null) } : {}),
              } as const;
              return (
                <span key={b.id}>
                  {b.href ? (
                    <Link href={b.href} {...(b.linkData ?? {})} {...common}>{content}</Link>
                  ) : (
                    <span {...common}>{content}</span>
                  )}
                  {b.end == null && b.tone === 'live' && !claimed && (
                    <span aria-hidden="true" className="absolute top-[7px] z-[2] h-9 w-1 animate-status-pulse bg-accent" style={{ left: `calc(${pct(end)} - 4px)` }} />
                  )}
                  {claimed && (
                    // Beside the marker: the full label when the slot was free
                    // long enough to hold it, else just the word.
                    <span
                      data-testid="lane-claimed-label"
                      className="pointer-events-none absolute top-[9px] z-[7] flex h-8 items-center justify-end gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[11.5px]"
                      style={{ right: `calc(${nowRight}% + 18px)`, ...(gap >= OUTSIDE_LABEL_FRACTION ? { maxWidth: `calc(${gap * 100}% - 24px)` } : {}) }}
                    >
                      {gap >= OUTSIDE_LABEL_FRACTION && <BarLabel bar={b} />}
                      <span className="shrink-0 bg-card px-1 text-[11px] md:text-[10.5px] font-semibold uppercase tracking-[0.8px] text-accent-text">claimed</span>
                    </span>
                  )}
                  {b.tone === 'waiting' && (
                    <span aria-hidden="true" className="absolute top-[9px] z-[5] grid h-8 w-[22px] place-items-center bg-accent text-[13px] font-bold text-white" style={{ left: `calc(${pct(end)} - 22px)` }}>?</span>
                  )}
                  {outside && (
                    <span
                      className="pointer-events-none absolute top-[9px] flex h-8 items-center justify-end gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[11.5px]"
                      style={{ right: `calc(${(1 - startFrac) * 100}% + 8px)`, maxWidth: `calc(${gap * 100}% - 16px)` }}
                    >
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

      {hoverCard && hovered && (() => {
        const c = barCard(hovered, { now, clock: tickLabel });
        return (
          <div
            ref={cardRef}
            data-testid="lane-bar-card"
            role="tooltip"
            className="pointer-events-none fixed z-50 flex flex-col gap-1 border-2 border-border-strong bg-card px-3 py-2.5 font-mono text-[12px] leading-snug shadow-[var(--card-shadow)]"
            // First paint is unpositioned and hidden: it exists to be measured.
            style={card ? { left: card.left, top: card.top, width: CARD_PX } : { left: 0, top: 0, width: CARD_PX, visibility: 'hidden' }}
          >
            <span className="flex min-w-0 items-center gap-1.5 font-semibold text-text-primary"><BarLabel bar={hovered} /></span>
            {c.title && <span className="line-clamp-3 text-text-secondary">{c.title}</span>}
            <span className="tabular-nums text-text-muted">{c.when}</span>
            {c.details.map(d => <span key={d} className="text-text-secondary">{d}</span>)}
            {hovered.href && <span className="text-[11px] text-[var(--fleet-faint)]">Click to open</span>}
          </div>
        );
      })()}

      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-[4] h-full w-full overflow-visible">
        {edges.map((e, i) => (
          <g key={i} data-testid="slot-lanes-edge">
            <path d={e.d} fill="none" stroke="var(--text-primary)" strokeWidth={1.5} />
            <rect x={e.x - 3} y={e.y - 1} width={6} height={6} fill="var(--text-primary)" />
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
      <span className={`min-w-0 truncate font-semibold ${bar.tone === 'foreign' || bar.tone === 'side' ? 'font-medium text-[var(--fleet-faint)]' : bar.tone === 'stopped' ? 'font-medium text-text-secondary' : 'text-text-primary'}`}>{bar.label}</span>
    </>
  );
}
