import type { MissionSegmentState } from '@buildd/core/mission-helpers';
import type { SegmentState as ChainSegmentState } from '@/lib/task-presentation';

export type SegmentState = MissionSegmentState | ChainSegmentState;
/**
 * Glyph vocabulary — mission states, plus 'skipped' (a cancelled, non-blocking
 * dep) and the two rail-only states the mobile timeline needs: 'ring' (a live
 * worker) and 'dashed' (advisory-gated or stranded).
 */
type Glyph = MissionSegmentState | 'skipped' | 'ring' | 'dashed';
export type RailGlyphState = Glyph;
/**
 * Node outline. Circles are tasks; squares mark non-task rail elements — the
 * mission's goal root and, since mission-legibility.md Rule R4-6, the phase
 * header. Never ambiguous: the goal root is always the rail's last row and
 * always carries `Goal:` text; a phase header is never last and never does.
 */
export type SegmentShape = 'box' | 'circle' | 'square';
const normalize = (state: SegmentState): Glyph => state === 'filled' ? 'solid' : state === 'current' ? 'ghost' : state;
const color: Record<Glyph, string> = { solid: 'text-status-success', half: 'text-status-warning', ghost: 'text-text-primary', empty: 'text-text-muted', notch: 'text-status-error', skipped: 'text-text-muted', ring: 'text-status-warning', dashed: 'text-text-muted' };
const SKIPPED_BG = 'bg-[linear-gradient(45deg,transparent_44%,currentColor_45%_55%,transparent_56%)]';

function SegmentGlyph({ state }: { state: SegmentState }) {
  const value = normalize(state);
  if (value === 'solid') return <span className="block size-2 bg-current" />;
  if (value === 'half') return <span className="block size-2 border border-current bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]" />;
  if (value === 'ghost') return <span className="block size-2 border border-current bg-[repeating-linear-gradient(135deg,currentColor_0_1px,transparent_1px_3px)]" />;
  if (value === 'notch') return <span className="block size-2 border border-current bg-[linear-gradient(45deg,transparent_42%,currentColor_43%_57%,transparent_58%)]" />;
  // skipped: a struck-through box — satisfied, but never delivered.
  if (value === 'skipped') return <span className={`block size-2 border border-current opacity-50 ${SKIPPED_BG}`} />;
  if (value === 'ring') return <span className="block size-2 border-2 border-current" />;
  if (value === 'dashed') return <span className="block size-2 border border-dashed border-current" />;
  return <span className="block size-2 border border-current opacity-35" />;
}

/**
 * One rail node (timeline-mobile-rail.md §7, §10.2).
 *
 * Same glyph state machine as `SegmentGlyph` above — this variant only changes
 * the outline (`shape`) and the size, so the rail and the progress strips stay
 * one vocabulary rather than two. `color` above is the single fill source; the
 * caller passes the state `deriveStage()` produced and nothing else.
 */
export function RailNodeGlyph({
  state,
  shape = 'circle',
  tone,
  pulse = false,
  title,
}: {
  state: RailGlyphState;
  shape?: SegmentShape;
  /** Colour class. Defaults to the shared `color` table for the state. */
  tone?: string;
  pulse?: boolean;
  title?: string;
}) {
  const radius = shape === 'circle' ? 'rounded-full' : '';
  const body =
    state === 'solid' ? 'bg-current'
    : state === 'ring' ? 'border-2 border-current'
    : state === 'dashed' ? 'border border-dashed border-current'
    : state === 'notch' ? `border border-current ${SKIPPED_BG}`
    : state === 'skipped' ? `border border-current opacity-50 ${SKIPPED_BG}`
    : state === 'half' ? 'border border-current bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]'
    : 'border border-current opacity-60';
  return (
    <span
      className={`block size-2.5 shrink-0 ${radius} ${body} ${tone ?? color[state]} ${pulse ? 'animate-pulse' : ''}`}
      title={title}
      aria-hidden="true"
    />
  );
}

export function SegmentStrip({ segments, continuous = segments.length > 8, label, height, maxWidth }: { segments: Array<{ taskId: string; state: SegmentState }>; continuous?: boolean; label?: string; height?: number; maxWidth?: number }) {
  if (!segments.length) return null;
  if (!continuous) return <div className="flex min-w-0 items-center gap-0.5" role="img" aria-label={label}>{segments.map(segment => <span key={segment.taskId} className={color[normalize(segment.state)]}><SegmentGlyph state={segment.state} /></span>)}</div>;
  return <div className="flex h-2 min-w-0 flex-1 border border-border-default" role="img" aria-label={label} style={{ height: height !== undefined ? `${height}px` : undefined, maxWidth: maxWidth !== undefined ? `${maxWidth}px` : undefined }}>{segments.map(segment => { const state = normalize(segment.state); return <span key={segment.taskId} className={`h-full flex-1 ${color[state]} ${state === 'solid' ? 'bg-current' : state === 'half' ? 'bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]' : state === 'ghost' ? 'bg-[repeating-linear-gradient(135deg,currentColor_0_1px,transparent_1px_4px)]' : state === 'notch' ? 'bg-[linear-gradient(45deg,transparent_42%,currentColor_43%_57%,transparent_58%)]' : state === 'skipped' ? `opacity-50 ${SKIPPED_BG}` : ''}`} />; })}</div>;
}
