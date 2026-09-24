'use client';

/**
 * The mission pulse: one segment per deliverable, in a position that never
 * moves (docs/design/mission-feed-mobile-continuity.md, "The shared object").
 *
 * Renders `buildPulseSegments` output and nothing else — the order, the phase
 * gaps and the > 40 fold are the builder's, so card, header and context
 * variants cannot disagree. It is the `SegmentStrip` vocabulary (one segment
 * per task, state as fill) specialised with a selection, an in-view underline
 * and a scrub gesture; colour comes from `PULSE_STATE_TOKEN`, never a literal.
 *
 * Variants:
 * - `card`: 8px, inert (Home and list cards).
 * - `header`: 12px inside a 40px touch band, scrubbable (sticky detail header).
 * - `context`: 8px with the current task ringed (sheet header, task page).
 */
import { useMemo, useRef, useState } from 'react';
import { PULSE_STATE_TOKEN, type PulseSegment, type PulseState } from '@/lib/mission-pulse';
import { useMissionFocusSnapshot, useMissionFocusStore } from './mission-focus-context';

export type PulseVariant = 'card' | 'header' | 'context';

/** Class sets per variant. `band` is the touch target; `bar` is the visual strip. */
export const PULSE_VARIANT: Record<PulseVariant, { band: string; bar: string }> = {
  card: { band: '', bar: 'h-2' },
  header: { band: 'relative flex h-10 items-center cursor-pointer select-none', bar: 'h-3' },
  context: { band: '', bar: 'h-2' },
};

type Token = (typeof PULSE_STATE_TOKEN)[PulseState];

/** Token → fill class. The only place pulse colour is spelled. */
export const PULSE_TOKEN_BG: Record<Token, string> = {
  accent: 'bg-accent',
  info: 'bg-status-info',
  border: 'bg-border-default',
  success: 'bg-status-success',
  error: 'bg-status-error',
};

/** Token → text class, for glyphs that sit beside the pulse (rows, captions). */
export const PULSE_TOKEN_TEXT: Record<Token, string> = {
  accent: 'text-accent-text',
  info: 'text-status-info',
  border: 'text-text-muted',
  success: 'text-status-success',
  error: 'text-status-error',
};

export const PULSE_STATE_LABEL: Record<PulseState, string> = {
  needs_you: 'needs you',
  moving: 'running',
  queued: 'queued',
  done: 'done',
  failed: 'failed',
  skipped: 'cancelled',
};

/** Done / total over rows (a folded phase segment counts its rows). */
export function pulseDoneCounts(segments: readonly PulseSegment[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const s of segments) {
    if (s.kind === 'phase') {
      total += s.taskIds.length;
      done += Math.round(s.fill * s.taskIds.length);
    } else {
      total += 1;
      if (s.state === 'done' || s.state === 'skipped') done += 1;
    }
  }
  return { done, total };
}

// ─── Geometry (pure) ─────────────────────────────────────────────────────────

/** Phase-boundary gap, px. Segments inside a phase touch (a hairline separates them visually). */
export const PULSE_PHASE_GAP_PX = 2;

/** Horizontal extent of each segment across `width` px. */
export function pulseLayout(segments: readonly PulseSegment[], width: number): Array<{ start: number; end: number }> {
  const gaps = segments.filter((s, i) => i > 0 && s.gapBefore).length;
  const segW = segments.length ? Math.max(0, width - gaps * PULSE_PHASE_GAP_PX) / segments.length : 0;
  const out: Array<{ start: number; end: number }> = [];
  let x = 0;
  segments.forEach((s, i) => {
    if (i > 0 && s.gapBefore) x += PULSE_PHASE_GAP_PX;
    out.push({ start: x, end: x + segW });
    x += segW;
  });
  return out;
}

/** Index of the segment under `x`; gaps and overshoot snap to the nearest. */
export function segmentAt(x: number, layout: ReadonlyArray<{ start: number; end: number }>): number {
  if (layout.length === 0) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < layout.length; i++) {
    const { start, end } = layout[i];
    if (x >= start && x <= end) return i;
    const d = x < start ? start - x : x - end;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** A click this soon after a handled pointer release is the same tap; swallow it. */
const CLICK_AFTER_RELEASE_MS = 500;

/**
 * The scrub gesture, as a plain state machine over x positions: press
 * previews, moving follows the finger, release selects. `cancel` is the
 * browser taking the gesture for a vertical page scroll (`touch-action: pan-y`).
 */
export function createPulseScrub({
  onPreview,
  onSelect,
  now = () => Date.now(),
}: {
  onPreview: (taskId: string | null) => void;
  onSelect: (taskId: string) => void;
  now?: () => number;
}) {
  let active = false;
  let previewed: string | null = null;
  let releasedAt = -Infinity;

  const at = (x: number, width: number, segs: readonly PulseSegment[]) => segs[segmentAt(x, pulseLayout(segs, width))]?.taskId ?? null;
  const preview = (id: string | null) => {
    if (id === previewed) return;
    previewed = id;
    onPreview(id);
  };

  return {
    down(x: number, width: number, segs: readonly PulseSegment[]) {
      active = true;
      preview(at(x, width, segs));
    },
    move(x: number, width: number, segs: readonly PulseSegment[]) {
      if (active) preview(at(x, width, segs));
    },
    up(x: number, width: number, segs: readonly PulseSegment[]) {
      if (!active) return;
      active = false;
      const id = at(x, width, segs);
      preview(id);
      if (id) onSelect(id);
      releasedAt = now();
      preview(null);
    },
    cancel() {
      active = false;
      preview(null);
    },
    /** A click (keyboard Enter/Space, or a pointer click the scrub did not see). */
    click(taskId: string) {
      if (now() - releasedAt < CLICK_AFTER_RELEASE_MS) return;
      onSelect(taskId);
    },
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface MissionPulseProps {
  segments: readonly PulseSegment[];
  variant: PulseVariant;
  selectedTaskId?: string | null;
  inViewTaskIds?: ReadonlySet<string>;
  /** Makes segments selectable. Scrub is enabled for the `header` variant. */
  onSegmentSelect?: (taskId: string) => void;
  /** Read selection, in-view and select from the enclosing `MissionFocusProvider`. */
  connected?: boolean;
  /** taskId → text for the floating scrub label (e.g. the task title). */
  segmentLabels?: Readonly<Record<string, string>>;
  className?: string;
}

/** Token → faint fill: a phase segment's track, and the ghost's body. Literal for Tailwind's scanner. */
const PULSE_TOKEN_TRACK: Record<Token, string> = {
  accent: 'bg-accent/30',
  info: 'bg-status-info/30',
  border: 'bg-border-default',
  success: 'bg-status-success/30',
  error: 'bg-status-error/30',
};

function segmentClasses(seg: PulseSegment): string {
  const token = PULSE_STATE_TOKEN[seg.state];
  // A folded phase: its aggregate state tints the track; the done fraction fills it (inner span).
  if (seg.kind === 'phase') return PULSE_TOKEN_TRACK[token];
  // The ghost: a faint body with a pulsing trailing edge (inner span).
  if (seg.state === 'moving') return PULSE_TOKEN_TRACK[token];
  if (seg.state === 'skipped') return `${PULSE_TOKEN_BG[token]} opacity-50`;
  return PULSE_TOKEN_BG[token];
}

export default function MissionPulse({
  segments,
  variant,
  selectedTaskId: selectedProp,
  inViewTaskIds: inViewProp,
  onSegmentSelect: onSelectProp,
  connected = false,
  segmentLabels,
  className = '',
}: MissionPulseProps) {
  const focusStore = useMissionFocusStore();
  const focus = useMissionFocusSnapshot();
  const live = connected && focusStore && focus;
  const selectedTaskId = selectedProp ?? (live ? focus.selectedTaskId : null);
  const inViewTaskIds = inViewProp ?? (live ? focus.inViewTaskIds : undefined);
  const onSelect = onSelectProp ?? (live ? focusStore.selectSegment : undefined);

  const [previewId, setPreviewId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const scrub = useMemo(
    () => createPulseScrub({ onPreview: setPreviewId, onSelect: id => onSelectRef.current?.(id) }),
    [],
  );

  if (segments.length === 0) return null;

  const spec = PULSE_VARIANT[variant];
  const interactive = !!onSelect;
  const scrubbable = interactive && variant === 'header';
  const { done, total } = pulseDoneCounts(segments);
  const layout = previewId ? pulseLayout(segments, 100) : null;
  const previewIdx = previewId ? segments.findIndex(s => s.taskId === previewId) : -1;
  const preview = previewIdx >= 0 ? segments[previewIdx] : null;
  const tabStop = segments.some(s => s.taskId === selectedTaskId) ? selectedTaskId : segments[0].taskId;

  const localX = (e: React.PointerEvent) => {
    const rect = (barRef.current ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
    return { x: e.clientX - rect.left, width: rect.width };
  };

  const bar = (
    <div ref={barRef} className={`relative flex w-full min-w-0 ${spec.bar}`}>
      {segments.map(seg => {
        const selected = seg.taskId === selectedTaskId;
        const ringed = variant === 'context' && selected;
        const inView = inViewTaskIds?.has(seg.taskId) ?? false;
        const label = `${segmentLabels?.[seg.taskId] ?? seg.phaseLabel ?? 'Task'} · ${PULSE_STATE_LABEL[seg.state]}`;
        const common = {
          'data-testid': 'mission-pulse-segment',
          'data-task-id': seg.taskId,
          'data-state': seg.state,
          'data-kind': seg.kind,
          'data-gap-before': String(seg.gapBefore),
          'data-in-view': String(inView),
          'data-ringed': String(ringed),
          'aria-current': selected ? ('true' as const) : undefined,
          className: [
            'relative h-full min-w-0 flex-1 border-r border-transparent bg-clip-padding last:border-r-0',
            seg.gapBefore ? 'ml-[2px]' : '',
            segmentClasses(seg),
            ringed ? 'z-10 outline outline-2 outline-offset-1 outline-text-primary' : '',
            selected && !ringed && interactive ? 'z-10 outline outline-1 outline-offset-1 outline-accent' : '',
          ].filter(Boolean).join(' '),
        };
        const inner = (
          <>
            {seg.kind === 'phase' && (
              <span
                aria-hidden="true"
                className={`absolute inset-y-0 left-0 ${PULSE_TOKEN_BG[PULSE_STATE_TOKEN.done]}`}
                style={{ width: `${Math.round(seg.fill * 100)}%` }}
              />
            )}
            {seg.kind === 'task' && seg.state === 'moving' && (
              <span
                data-testid="mission-pulse-ghost"
                aria-hidden="true"
                className="absolute inset-y-0 right-0 w-1/3 bg-status-info animate-pulse motion-reduce:animate-none"
              />
            )}
            {inView && <span aria-hidden="true" className="absolute inset-x-0 -bottom-1 h-0.5 bg-text-primary" />}
          </>
        );
        return interactive ? (
          <button
            key={seg.taskId}
            type="button"
            {...common}
            aria-label={label}
            tabIndex={seg.taskId === tabStop ? 0 : -1}
            onClick={() => scrub.click(seg.taskId)}
          >
            {inner}
          </button>
        ) : (
          <span key={seg.taskId} {...common}>{inner}</span>
        );
      })}
    </div>
  );

  return (
    <div
      data-testid="mission-pulse"
      data-variant={variant}
      role="group"
      aria-label={`Mission progress: ${done} of ${total} done`}
      className={`${spec.band || 'relative flex items-center'} min-w-0 ${className}`}
      style={scrubbable ? { touchAction: 'pan-y' } : undefined}
      onPointerDown={scrubbable ? e => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        const { x, width } = localX(e);
        scrub.down(x, width, segments);
      } : undefined}
      onPointerMove={scrubbable ? e => { const { x, width } = localX(e); scrub.move(x, width, segments); } : undefined}
      onPointerUp={scrubbable ? e => { const { x, width } = localX(e); scrub.up(x, width, segments); } : undefined}
      onPointerCancel={scrubbable ? () => scrub.cancel() : undefined}
      onKeyDown={interactive ? e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const buttons = [...(barRef.current?.querySelectorAll('button') ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === 'ArrowRight' ? 1 : -1)))];
        next?.focus();
        e.preventDefault();
      } : undefined}
    >
      {bar}
      {preview && layout && (
        <div
          role="status"
          data-testid="mission-pulse-scrub-label"
          className="pointer-events-none absolute bottom-full z-20 mb-1 max-w-[70%] -translate-x-1/2 truncate border border-border-strong bg-card px-1.5 py-0.5 font-mono text-[11px] text-text-primary shadow-sm"
          style={{ left: `${Math.min(85, Math.max(15, (layout[previewIdx].start + layout[previewIdx].end) / 2))}%` }}
        >
          {segmentLabels?.[preview.taskId] ?? preview.phaseLabel ?? 'Task'} · {PULSE_STATE_LABEL[preview.state]}
        </div>
      )}
    </div>
  );
}
